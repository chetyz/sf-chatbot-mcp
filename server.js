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

// Cache para respuestas frecuentes (10 minutos)
const responseCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

// Función para enviar mensajes JSON-RPC al servidor MCP
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
    console.log('🔧 Iniciando MCP Server...');
    
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
        // Ignorar logs no-JSON
      }
    });

    mcpProcess.stderr.on('data', (data) => {
      const error = data.toString();
      if (error.includes('ERROR') || error.includes('FATAL')) {
        console.error('⚠️ MCP stderr:', error);
      }
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    await sendMCPMessage('initialize', {
      protocolVersion: "0.1.0",
      capabilities: {},
      clientInfo: {
        name: "salesforce-chatbot",
        version: "1.0.0"
      }
    });
    console.log('✅ MCP inicializado');

    const toolsResponse = await sendMCPMessage('tools/list');
    mcpTools = toolsResponse.tools || [];
    
    console.log(`🛠️ Herramientas MCP: ${mcpTools.length} disponibles`);
    return true;
  } catch (error) {
    console.error('❌ Error inicializando MCP Server:', error);
    return false;
  }
}

// Detectar consultas simples que no necesitan herramientas
function isSimpleQuery(question) {
  const lowerQ = question.toLowerCase();
  
  // Saludos y conversación básica
  if (lowerQ.match(/^(hola|hi|hello|buenos días|buenas tardes|hey)$/)) {
    return { simple: true, response: "¡Hola! Soy tu asistente de Salesforce. ¿En qué puedo ayudarte con tus datos de ventas?" };
  }
  
  // Consultas sobre personas famosas (no están en SF)
  if (lowerQ.includes('cristiano ronaldo') || lowerQ.includes('messi') || lowerQ.includes('famous') || 
      lowerQ.includes('celebrity') || lowerQ.includes('actor') || lowerQ.includes('cantante')) {
    return { simple: true, response: "Parece que preguntas sobre una persona famosa. Mi función es ayudarte con datos de tu Salesforce. ¿Tienes alguna consulta sobre leads, oportunidades, cuentas o contactos de tu organización?" };
  }
  
  return { simple: false };
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'SF Chatbot - BALANCED COST & INTELLIGENCE',
    timestamp: new Date().toISOString(),
    claude_api: ANTHROPIC_API_KEY ? 'configured' : 'missing',
    mcp_server: mcpProcess ? 'running' : 'stopped',
    mcp_tools: mcpTools.length,
    cache_size: responseCache.size,
    mode: 'COST_OPTIMIZED_CLAUDE',
    model: 'claude-3-haiku-20240307 + cache'
  });
});

// Endpoint principal con optimización de costos
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

    // Verificar consultas simples primero
    const simpleCheck = isSimpleQuery(question);
    if (simpleCheck.simple) {
      console.log('⚡ Respuesta simple sin herramientas');
      return res.json({
        response: simpleCheck.response,
        mode: 'simple_response',
        cost: '$0.000',
        timestamp: new Date().toISOString()
      });
    }

    // Verificar cache
    const cacheKey = question.toLowerCase().trim();
    const cached = responseCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      console.log('💰 Respuesta desde cache');
      return res.json({
        response: cached.response,
        mode: 'cached',
        cost: '$0.000',
        timestamp: new Date().toISOString()
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

    // Usar modelo más barato pero con prompts optimizados
    const claudeResponse = await callClaudeOptimized(question);
    
    // Guardar en cache si es exitoso
    if (claudeResponse && !claudeResponse.includes('Error')) {
      responseCache.set(cacheKey, {
        response: claudeResponse,
        timestamp: Date.now()
      });
    }
    
    res.json({ 
      response: claudeResponse,
      mode: 'optimized_claude',
      cost: '$0.015', // Costo estimado reducido
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

// Claude optimizado para costos
async function callClaudeOptimized(question) {
  try {
    console.log('🤖 Claude optimizado para costo-calidad...');
    
    const claudeTools = mcpTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema
    }));

    // Sistema de prompts más conciso pero efectivo
    const systemPrompt = `Eres un asistente de Salesforce experto. 

INSTRUCCIONES:
1. Usa herramientas MCP para obtener datos reales de Salesforce
2. Da respuestas directas, útiles y completas
3. Incluye números específicos y detalles relevantes
4. Responde en español de forma profesional
5. Para consultas imposibles (datos futuros, personas famosas), explica brevemente por qué

Proporciona análisis valiosos con los datos que obtengas.`;

    let messages = [{
      role: 'user',
      content: question
    }];

    // Primera llamada con modelo más barato
    let response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307', // Modelo más barato
        max_tokens: 2000, // Reducido de 3000
        temperature: 0.1,
        system: systemPrompt,
        messages: messages,
        tools: claudeTools
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }

    let data = await response.json();
    console.log('📡 Respuesta inicial de Claude recibida');
    
    // Máximo 2 iteraciones para controlar costos
    let iterationCount = 0;
    const maxIterations = 2;
    
    while (data.content && data.content.some(item => item.type === 'tool_use') && iterationCount < maxIterations) {
      console.log(`🔧 Claude ejecutando herramientas (iteración ${iterationCount + 1})`);
      
      messages.push({
        role: 'assistant',
        content: data.content
      });

      const toolResults = [];
      
      for (const item of data.content) {
        if (item.type === 'tool_use') {
          console.log(`⚡ Ejecutando: ${item.name}`);
          
          try {
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
            console.error(`❌ Error ejecutando ${item.name}:`, toolError.message);
            
            toolResults.push({
              type: 'tool_result',
              tool_use_id: item.id,
              content: JSON.stringify({ 
                error: toolError.message,
                message: "Error ejecutando herramienta de Salesforce."
              }),
              is_error: true
            });
          }
        }
      }

      messages.push({
        role: 'user',
        content: toolResults
      });

      // Nueva llamada a Claude
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
          system: systemPrompt,
          messages: messages,
          tools: claudeTools
        })
      });

      if (!response.ok) {
        throw new Error(`Claude API error: ${response.status}`);
      }

      data = await response.json();
      iterationCount++;
      console.log(`📡 Respuesta de Claude (iteración ${iterationCount}) recibida`);
    }
    
    const finalText = data.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join(' ')
      .trim();
    
    if (!finalText) {
      return 'Lo siento, no pude procesar tu consulta. ¿Podrías reformular tu pregunta?';
    }
    
    console.log('✅ Respuesta final generada');
    return finalText;
    
  } catch (error) {
    console.error('❌ Error en Claude:', error);
    return `❌ Error procesando tu consulta: ${error.message}`;
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
  console.log(`🧹 Cache limpiado. Tamaño actual: ${responseCache.size}`);
}, CACHE_TTL);

app.get('/keepalive', (req, res) => {
  res.json({ 
    status: 'alive', 
    timestamp: new Date().toISOString(),
    mode: 'COST_OPTIMIZED_CLAUDE',
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
  console.log(`🚀 Server COST-OPTIMIZED running on port ${PORT}`);
  console.log(`🔑 Claude API: ${ANTHROPIC_API_KEY ? 'Configurado ✅' : 'Faltante ❌'}`);
  console.log(`⚡ Modo: COST-OPTIMIZED CLAUDE`);
  console.log(`🧠 Modelo: claude-3-haiku (5x más barato)`);
  console.log(`💰 Costo objetivo: $0.01-0.015 por consulta`);
  console.log(`🔄 Cache: 10 minutos para consultas frecuentes`);
  console.log(`📦 Node version: ${process.version}`);
  
  const connected = await initMCPServer();
  if (!connected) {
    console.log('⚠️ MCP no disponible - verificar credenciales SF');
  } else {
    console.log('🎉 ¡Sistema costo-optimizado listo!');
  }
});
