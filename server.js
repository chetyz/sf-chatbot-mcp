const express = require('express');
const { spawn } = require('child_process');
const readline = require('readline');

const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

let mcpProcess = null;
let mcpTools = [];
let requestId = 0;
const pendingRequests = new Map();

// Cache simple para respuestas frecuentes (5 minutos)
const responseCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// Función para enviar mensajes JSON-RPC al servidor MCP (optimizada)
function sendMCPMessage(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const message = {
      jsonrpc: "2.0",
      id: id,
      method: method,
      params: params
    };
    
    pendingRequests.set(id, { resolve, reject });
    
    if (mcpProcess && mcpProcess.stdin) {
      mcpProcess.stdin.write(JSON.stringify(message) + '\n');
    } else {
      reject(new Error('MCP process not available'));
    }
    
    // Timeout reducido a 25 segundos
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('MCP request timeout'));
      }
    }, 25000);
  });
}

// Inicializar conexión con MCP Server
async function initMCPServer() {
  try {
    console.log('🔧 Iniciando MCP Server (Modo Optimizado)...');
    
    mcpProcess = spawn('npx', ['-y', '@tsmztech/mcp-server-salesforce'], {
      env: {
        ...process.env,
        SALESFORCE_CONNECTION_TYPE: "User_Password",
        SALESFORCE_USERNAME: process.env.SALESFORCE_USERNAME,
        SALESFORCE_PASSWORD: process.env.SALESFORCE_PASSWORD,
        SALESFORCE_TOKEN: process.env.SALESFORCE_TOKEN,
        SALESFORCE_INSTANCE_URL: process.env.SALESFORCE_INSTANCE_URL || "https://login.salesforce.com"
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    mcpProcess.on('error', (error) => {
      console.error('❌ Error en proceso MCP:', error);
    });

    mcpProcess.on('exit', (code) => {
      console.log(`⚠️ MCP Server terminó con código: ${code}`);
      mcpProcess = null;
    });

    const rl = readline.createInterface({
      input: mcpProcess.stdout,
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        
        if (message.id && pendingRequests.has(message.id)) {
          const { resolve, reject } = pendingRequests.get(message.id);
          pendingRequests.delete(message.id);
          
          if (message.error) {
            reject(new Error(message.error.message || 'MCP error'));
          } else {
            resolve(message.result);
          }
        }
      } catch (e) {
        // Ignorar logs no-JSON para mejor performance
      }
    });

    mcpProcess.stderr.on('data', (data) => {
      // Solo log de errores críticos
      const error = data.toString();
      if (error.includes('ERROR') || error.includes('FATAL')) {
        console.error('⚠️ MCP stderr:', error);
      }
    });

    await new Promise(resolve => setTimeout(resolve, 1500));

    await sendMCPMessage('initialize', {
      protocolVersion: "0.1.0",
      capabilities: {},
      clientInfo: {
        name: "salesforce-chatbot",
        version: "1.0.0"
      }
    });
    console.log('✅ MCP inicializado (modo rápido)');

    const toolsResponse = await sendMCPMessage('tools/list');
    mcpTools = toolsResponse.tools || [];
    
    console.log(`🛠️ Herramientas MCP: ${mcpTools.length} disponibles`);
    return true;
  } catch (error) {
    console.error('❌ Error inicializando MCP Server:', error);
    return false;
  }
}

// Health check optimizado
app.get('/', (req, res) => {
  res.json({ 
    status: 'SF Chatbot - OPTIMIZED FIXED VERSION',
    timestamp: new Date().toISOString(),
    claude_api: ANTHROPIC_API_KEY ? 'configured' : 'missing',
    mcp_server: mcpProcess ? 'running' : 'stopped',
    mcp_tools: mcpTools.length,
    cache_size: responseCache.size,
    mode: 'FAST_AND_RELIABLE',
    model: 'claude-3-haiku-20240307',
    cost_optimization: 'ENABLED'
  });
});

// Función para detectar tipo de consulta y optimizar approach
function analyzeQuery(question) {
  const lowerQ = question.toLowerCase();
  
  // Consultas simples que pueden usar handlers optimizados
  if (lowerQ.includes('cuantos') && lowerQ.includes('lead')) {
    return { type: 'count_leads', cache_key: 'leads_count' };
  }
  
  if ((lowerQ.includes('cuantos') || lowerQ.includes('cuantas')) && (lowerQ.includes('vendedor') || lowerQ.includes('usuario'))) {
    return { type: 'count_users', cache_key: 'users_count' };
  }
  
  if (lowerQ.includes('oportunidad') && (lowerQ.includes('monto') || lowerQ.includes('alto') || lowerQ.includes('grande') || lowerQ.includes('mayor'))) {
    return { type: 'top_opportunity', cache_key: 'top_opp' };
  }
  
  if ((lowerQ.includes('cuantas') || lowerQ.includes('cuantos')) && lowerQ.includes('oportunidad')) {
    return { type: 'count_opportunities', cache_key: 'opp_count' };
  }
  
  if ((lowerQ.includes('mejor') || lowerQ.includes('top')) && lowerQ.includes('vendedor')) {
    return { type: 'top_salesperson', cache_key: 'top_sales' };
  }
  
  // Consulta compleja - usar Claude completo
  return { type: 'complex', cache_key: null };
}

// Endpoint principal optimizado
app.post('/chat', async (req, res) => {
  try {
    const { question } = req.body;
    
    if (!question) {
      return res.status(400).json({ error: 'Pregunta requerida' });
    }

    console.log('📝 Pregunta:', question);

    if (!ANTHROPIC_API_KEY) {
      return res.json({ 
        response: `[MODO BÁSICO] Pregunta: ${question}. Configura ANTHROPIC_API_KEY.`,
        mode: 'basic'
      });
    }

    if (!mcpProcess) {
      const connected = await initMCPServer();
      if (!connected) {
        return res.json({
          response: "❌ Error: No puedo conectar con Salesforce. Verifica las credenciales.",
          mode: 'error'
        });
      }
    }

    // Analizar tipo de consulta para optimizar
    const queryAnalysis = analyzeQuery(question);
    
    // Verificar cache primero
    if (queryAnalysis.cache_key) {
      const cached = responseCache.get(queryAnalysis.cache_key);
      if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        console.log('⚡ Respuesta desde cache');
        return res.json({
          response: cached.response,
          mode: 'cached',
          timestamp: new Date().toISOString(),
          cost: '$0.00'
        });
      }
    }
    
    let claudeResponse;
    let cost = 0;
    
    // Routing optimizado por tipo de consulta
    try {
      if (queryAnalysis.type === 'count_leads') {
        claudeResponse = await handleLeadsCount();
        cost = 0.005; // Muy barato
      } else if (queryAnalysis.type === 'count_users') {
        claudeResponse = await handleUsersCount();
        cost = 0.005;
      } else if (queryAnalysis.type === 'top_opportunity') {
        claudeResponse = await handleTopOpportunity();
        cost = 0.005;
      } else if (queryAnalysis.type === 'count_opportunities') {
        claudeResponse = await handleOpportunitiesCount();
        cost = 0.005;
      } else if (queryAnalysis.type === 'top_salesperson') {
        claudeResponse = await handleTopSalesperson();
        cost = 0.010;
      } else {
        // Solo para consultas complejas usar Claude completo
        claudeResponse = await callClaudeWithMCP(question);
        cost = 0.06; // Más caro pero solo para casos complejos
      }
    } catch (handlerError) {
      console.log(`⚠️ Handler failed, fallback to Claude: ${handlerError.message}`);
      claudeResponse = await callClaudeWithMCP(question);
      cost = 0.06;
    }
    
    // Guardar en cache
    if (queryAnalysis.cache_key && claudeResponse && !claudeResponse.includes('Error')) {
      responseCache.set(queryAnalysis.cache_key, {
        response: claudeResponse,
        timestamp: Date.now()
      });
    }
    
    res.json({ 
      response: claudeResponse,
      mode: 'optimized_fixed',
      query_type: queryAnalysis.type,
      estimated_cost: `$${cost.toFixed(3)}`,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error en /chat:', error);
    res.status(500).json({ 
      error: `Error del servidor: ${error.message}`,
      fallback: `⚠️ Hubo un problema procesando: "${req.body.question}".`
    });
  }
});

// Handlers optimizados CORREGIDOS
async function handleLeadsCount() {
  try {
    console.log('🔍 Ejecutando handleLeadsCount...');
    const result = await sendMCPMessage('tools/call', {
      name: 'salesforce:salesforce_aggregate_query',
      arguments: {
        objectName: 'Lead',
        selectFields: ['Status', 'COUNT(Id) Total'],
        groupByFields: ['Status']
      }
    });
    
    console.log('📊 Resultado leads:', JSON.stringify(result, null, 2));
    
    if (!result || !result.content) {
      throw new Error('No se recibieron datos de leads');
    }
    
    const records = result.content;
    const total = records.reduce((sum, record) => sum + (record.Total || 0), 0);
    
    let response = `📊 **Resumen de Leads**\n\nTotal: **${total} leads**\n\n**Por Estado:**\n`;
    records.forEach(record => {
      response += `• ${record.Status}: ${record.Total} leads\n`;
    });
    
    const openNotContacted = records.find(r => r.Status === 'Open - Not Contacted')?.Total || 0;
    response += `\n💡 **Insight rápido:** ${openNotContacted} leads esperan tu contacto.`;
    
    return response;
  } catch (error) {
    console.error('❌ Error en handleLeadsCount:', error);
    throw error;
  }
}

async function handleUsersCount() {
  try {
    console.log('🔍 Ejecutando handleUsersCount...');
    const result = await sendMCPMessage('tools/call', {
      name: 'salesforce:salesforce_query_records',
      arguments: {
        objectName: 'User',
        fields: ['Id', 'Name', 'Profile.Name', 'IsActive'],
        whereClause: 'IsActive = true'
      }
    });
    
    console.log('👥 Resultado users:', JSON.stringify(result, null, 2));
    
    if (!result || !result.content) {
      throw new Error('No se recibieron datos de usuarios');
    }
    
    const users = result.content;
    const salesUsers = users.filter(u => 
      u['Profile.Name'] && (
        u['Profile.Name'].includes('Sales') || 
        u['Profile.Name'].includes('Account') ||
        u['Profile.Name'].includes('Standard User')
      )
    );
    
    return `👥 **Usuarios Activos**\n\nTotal usuarios activos: **${users.length}**\nUsuarios de ventas: **${salesUsers.length}**\n\n💼 Tienes un equipo sólido para gestionar tu pipeline.`;
    
  } catch (error) {
    console.error('❌ Error en handleUsersCount:', error);
    throw error;
  }
}

async function handleTopOpportunity() {
  try {
    console.log('🔍 Ejecutando handleTopOpportunity...');
    const result = await sendMCPMessage('tools/call', {
      name: 'salesforce:salesforce_query_records',
      arguments: {
        objectName: 'Opportunity',
        fields: ['Name', 'Amount', 'StageName', 'Account.Name', 'CloseDate'],
        orderBy: 'Amount DESC NULLS LAST',
        limit: 1
      }
    });
    
    console.log('💰 Resultado opportunity:', JSON.stringify(result, null, 2));
    
    if (!result || !result.content || result.content.length === 0) {
      return "No se encontraron oportunidades en tu sistema.";
    }
    
    const opportunity = result.content[0];
    const amount = opportunity.Amount ? `$${opportunity.Amount.toLocaleString()}` : 'Monto no definido';
    
    return `🏆 **Oportunidad más grande**\n\n**${opportunity.Name || 'Sin nombre'}**\n• Monto: ${amount}\n• Cuenta: ${opportunity['Account.Name'] || 'No especificada'}\n• Estado: ${opportunity.StageName || 'Sin estado'}\n• Cierre: ${opportunity.CloseDate || 'No definido'}\n\n🎯 Esta es tu oportunidad estrella. ¡Manténla en el radar!`;
    
  } catch (error) {
    console.error('❌ Error en handleTopOpportunity:', error);
    throw error;
  }
}

async function handleOpportunitiesCount() {
  try {
    console.log('🔍 Ejecutando handleOpportunitiesCount...');
    const result = await sendMCPMessage('tools/call', {
      name: 'salesforce:salesforce_aggregate_query',
      arguments: {
        objectName: 'Opportunity',
        selectFields: ['StageName', 'COUNT(Id) Total', 'SUM(Amount) TotalAmount'],
        groupByFields: ['StageName']
      }
    });
    
    console.log('📈 Resultado opportunities:', JSON.stringify(result, null, 2));
    
    if (!result || !result.content) {
      throw new Error('No se recibieron datos de oportunidades');
    }
    
    const records = result.content;
    const total = records.reduce((sum, record) => sum + (record.Total || 0), 0);
    const totalAmount = records.reduce((sum, record) => sum + (record.TotalAmount || 0), 0);
    
    let response = `💰 **Pipeline de Oportunidades**\n\nTotal: **${total} oportunidades**\nValor total: **$${totalAmount.toLocaleString()}**\n\n**Por Etapa:**\n`;
    
    records.forEach(record => {
      const amount = record.TotalAmount ? `($${record.TotalAmount.toLocaleString()})` : '';
      response += `• ${record.StageName}: ${record.Total} ${amount}\n`;
    });
    
    return response;
    
  } catch (error) {
    console.error('❌ Error en handleOpportunitiesCount:', error);
    throw error;
  }
}

async function handleTopSalesperson() {
  try {
    console.log('🔍 Ejecutando handleTopSalesperson...');
    const result = await sendMCPMessage('tools/call', {
      name: 'salesforce:salesforce_aggregate_query',
      arguments: {
        objectName: 'Opportunity',
        selectFields: ['Owner.Name', 'COUNT(Id) TotalOpps', 'SUM(Amount) TotalRevenue'],
        groupByFields: ['Owner.Name'],
        orderBy: 'SUM(Amount) DESC NULLS LAST',
        limit: 5
      }
    });
    
    console.log('🏆 Resultado salesperson:', JSON.stringify(result, null, 2));
    
    if (!result || !result.content || result.content.length === 0) {
      return "No se encontraron datos de vendedores en tu sistema.";
    }
    
    const topSeller = result.content[0];
    const topRevenue = topSeller.TotalRevenue ? `$${topSeller.TotalRevenue.toLocaleString()}` : 'Ingresos no definidos';
    
    let response = `🏆 **Mejor Vendedor**\n\n**${topSeller['Owner.Name'] || 'Sin nombre'}**\n• Ingresos totales: ${topRevenue}\n• Oportunidades: ${topSeller.TotalOpps || 0}\n\n**Top 5 Vendedores:**\n`;
    
    result.content.forEach((seller, index) => {
      const revenue = seller.TotalRevenue ? `$${seller.TotalRevenue.toLocaleString()}` : '$0';
      response += `${index + 1}. ${seller['Owner.Name']} - ${revenue} (${seller.TotalOpps} opps)\n`;
    });
    
    return response;
    
  } catch (error) {
    console.error('❌ Error en handleTopSalesperson:', error);
    throw error;
  }
}

// Claude optimizado solo para casos complejos
async function callClaudeWithMCP(question) {
  try {
    console.log('🤖 Claude optimizado para consulta compleja...');
    
    const claudeTools = mcpTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema
    }));

    let messages = [{
      role: 'user',
      content: `Como asistente experto de Salesforce, responde esta consulta de forma directa y útil: "${question}"\n\nUsa las herramientas MCP para obtener datos reales de Salesforce. Proporciona respuestas completas con números específicos y análisis útil.`
    }];

    let response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 2000,
        temperature: 0.1,
        messages: messages,
        tools: claudeTools
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }

    let data = await response.json();
    
    // Solo una iteración para tool calls
    if (data.content && data.content.some(item => item.type === 'tool_use')) {
      console.log('🔧 Ejecutando herramientas (1 iteración)...');
      
      messages.push({ role: 'assistant', content: data.content });

      const toolResults = [];
      for (const item of data.content) {
        if (item.type === 'tool_use') {
          try {
            console.log(`⚡ Ejecutando: ${item.name}`);
            const result = await sendMCPMessage('tools/call', {
              name: item.name,
              arguments: item.input
            });
            
            toolResults.push({
              type: 'tool_result',
              tool_use_id: item.id,
              content: JSON.stringify(result.content || result, null, 2)
            });
          } catch (toolError) {
            console.error(`❌ Error en herramienta ${item.name}:`, toolError);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: item.id,
              content: JSON.stringify({ error: toolError.message }),
              is_error: true
            });
          }
        }
      }

      messages.push({ role: 'user', content: toolResults });

      // Segunda y FINAL llamada
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 2000,
          temperature: 0.1,
          messages: messages,
          tools: claudeTools
        })
      });

      if (!response.ok) {
        throw new Error(`Claude API error: ${response.status}`);
      }

      data = await response.json();
    }
    
    const finalText = data.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join(' ')
      .trim();
    
    return finalText || 'Error procesando respuesta.';
    
  } catch (error) {
    console.error('❌ Error en Claude optimizado:', error);
    return `❌ Error procesando consulta: ${error.message}`;
  }
}

// Limpiar cache periódicamente
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of responseCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      responseCache.delete(key);
    }
  }
}, CACHE_TTL);

app.get('/keepalive', (req, res) => {
  res.json({ 
    status: 'alive', 
    timestamp: new Date().toISOString(),
    mode: 'OPTIMIZED_FIXED_VERSION',
    cache_size: responseCache.size
  });
});

process.on('SIGTERM', async () => {
  console.log('🔄 Cerrando conexiones...');
  if (mcpProcess) {
    mcpProcess.kill();
  }
  process.exit(0);
});

app.listen(PORT, async () => {
  console.log(`🚀 Server OPTIMIZADO Y CORREGIDO running on port ${PORT}`);
  console.log(`🔑 Claude API: ${ANTHROPIC_API_KEY ? 'Configurado ✅' : 'Faltante ❌'}`);
  console.log(`⚡ Modo: SPEED & COST OPTIMIZED + FIXED`);
  console.log(`🧠 Modelo: claude-3-haiku (FAST & CHEAP)`);
  console.log(`💰 Costo estimado: $0.005-$0.06 por consulta`);
  console.log(`⚡ Cache: ENABLED para consultas frecuentes`);
  console.log(`🔧 Handlers: CORREGIDOS con mejor manejo de errores`);
  console.log(`📦 Node version: ${process.version}`);
  
  const connected = await initMCPServer();
  if (!connected) {
    console.log('⚠️ MCP no disponible - verificar credenciales SF');
  } else {
    console.log('🎉 ¡Sistema optimizado y corregido listo!');
  }
});
