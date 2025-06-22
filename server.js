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
    
    // Timeout de 30 segundos
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('MCP request timeout'));
      }
    }, 30000);
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

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'SF Chatbot - BACK TO FULL CLAUDE INTELLIGENCE',
    timestamp: new Date().toISOString(),
    claude_api: ANTHROPIC_API_KEY ? 'configured' : 'missing',
    mcp_server: mcpProcess ? 'running' : 'stopped',
    mcp_tools: mcpTools.length,
    mode: 'FULL_CLAUDE_POWER',
    model: 'claude-3-5-sonnet-20241022'
  });
});

// Endpoint principal - VUELTA A CLAUDE COMPLETO
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

    // USAR CLAUDE COMPLETO SIEMPRE - Los handlers optimizados fallan
    const claudeResponse = await callClaudeWithFullPower(question);
    
    res.json({ 
      response: claudeResponse,
      mode: 'full_claude_intelligence',
      timestamp: new Date().toISOString(),
      cost: '$0.08'
    });
    
  } catch (error) {
    console.error('❌ Error en /chat:', error);
    res.status(500).json({ 
      error: `Error del servidor: ${error.message}`,
      fallback: `⚠️ Hubo un problema procesando: "${req.body.question}".`
    });
  }
});

// Claude con máxima inteligencia - SIN handlers que fallan
async function callClaudeWithFullPower(question) {
  try {
    console.log('🤖 Claude con máxima inteligencia...');
    
    const claudeTools = mcpTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema
    }));

    // Sistema de prompts mejorado
    const systemPrompt = `Eres un asistente experto de Salesforce con acceso completo a herramientas MCP. 

INSTRUCCIONES CRÍTICAS:
1. SIEMPRE usa las herramientas MCP para obtener datos reales de Salesforce
2. Da respuestas completas, detalladas y útiles como Claude Sonnet
3. Analiza los datos que obtienes y proporciona insights valiosos
4. Incluye números específicos, nombres, fechas y detalles relevantes
5. Si encuentras datos interesantes adicionales, compártelos también
6. Responde en español de forma profesional pero amigable
7. Si hay múltiples registros relevantes, menciona los más importantes
8. Para consultas simples como saludos, responde naturalmente SIN usar herramientas

FORMATO DE RESPUESTA:
- Respuesta directa a la pregunta
- Datos específicos y números exactos
- Contexto adicional relevante cuando sea útil
- Insights o recomendaciones si corresponde

Eres tan inteligente como Claude Sonnet y debes dar respuestas de la misma calidad.`;

    let messages = [{
      role: 'user',
      content: question
    }];

    // Primera llamada a Claude con modelo potente
    let response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022', // Modelo más potente
        max_tokens: 3000, // Suficientes tokens para respuestas completas
        temperature: 0.3,
        system: systemPrompt,
        messages: messages,
        tools: claudeTools
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Claude API Error:', errorData);
      throw new Error(`Claude API error: ${response.status}`);
    }

    let data = await response.json();
    console.log('📡 Respuesta inicial de Claude recibida');
    
    // Procesar tool calls hasta 3 iteraciones máximo
    let iterationCount = 0;
    const maxIterations = 3;
    
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
          console.log(`📝 Parámetros:`, JSON.stringify(item.input, null, 2));
          
          try {
            const result = await sendMCPMessage('tools/call', {
              name: item.name,
              arguments: item.input
            });
            
            console.log(`✅ Resultado de ${item.name}:`, JSON.stringify(result, null, 2));
            
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
                message: "Error ejecutando herramienta de Salesforce. Intenta reformular tu pregunta."
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

      // Nueva llamada a Claude con resultados
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022',
          max_tokens: 3000,
          temperature: 0.3,
          system: systemPrompt,
          messages: messages,
          tools: claudeTools
        })
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Claude API error: ${response.status}`);
      }

      data = await response.json();
      iterationCount++;
      console.log(`📡 Respuesta de Claude (iteración ${iterationCount}) recibida`);
    }
    
    // Extraer respuesta final
    const finalText = data.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join(' ')
      .trim();
    
    if (!finalText) {
      return 'Lo siento, no pude procesar tu consulta correctamente. ¿Podrías reformular tu pregunta de manera más específica?';
    }
    
    console.log('✅ Respuesta final generada correctamente');
    return finalText;
    
  } catch (error) {
    console.error('❌ Error en Claude:', error);
    return `❌ Error procesando tu consulta: ${error.message}. Por favor intenta de nuevo.`;
  }
}

app.get('/keepalive', (req, res) => {
  res.json({ 
    status: 'alive', 
    timestamp: new Date().toISOString(),
    mode: 'FULL_CLAUDE_INTELLIGENCE'
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
  console.log(`🚀 Server CLAUDE FULL POWER running on port ${PORT}`);
  console.log(`🔑 Claude API: ${ANTHROPIC_API_KEY ? 'Configurado ✅' : 'Faltante ❌'}`);
  console.log(`⚡ Modo: CLAUDE FULL INTELLIGENCE - NO MÁS HANDLERS FALLIDOS`);
  console.log(`🧠 Modelo: claude-3-5-sonnet-20241022`);
  console.log(`💰 Costo: $0.08 por consulta pero RESPUESTAS PERFECTAS`);
  console.log(`📦 Node version: ${process.version}`);
  
  const connected = await initMCPServer();
  if (!connected) {
    console.log('⚠️ MCP no disponible - verificar credenciales SF');
  } else {
    console.log('🎉 ¡Claude con máxima inteligencia listo!');
  }
});
