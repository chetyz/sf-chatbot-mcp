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
    
    // Timeout después de 60 segundos
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('MCP request timeout'));
      }
    }, 60000);
  });
}

// Inicializar conexión con MCP Server
async function initMCPServer() {
  try {
    console.log('🔧 Iniciando MCP Server...');
    
    // Spawn del MCP server
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

    // Manejar errores del proceso
    mcpProcess.on('error', (error) => {
      console.error('❌ Error en proceso MCP:', error);
    });

    mcpProcess.on('exit', (code) => {
      console.log(`⚠️ MCP Server terminó con código: ${code}`);
      mcpProcess = null;
    });

    // Configurar lectura de stdout línea por línea
    const rl = readline.createInterface({
      input: mcpProcess.stdout,
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        
        // Si es una respuesta a una solicitud pendiente
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
        console.log('📝 MCP stdout (no JSON):', line);
      }
    });

    // Leer stderr
    mcpProcess.stderr.on('data', (data) => {
      console.error('⚠️ MCP stderr:', data.toString());
    });

    // Esperar un poco para que el servidor se inicialice
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Inicializar conexión
    await sendMCPMessage('initialize', {
      protocolVersion: "0.1.0",
      capabilities: {},
      clientInfo: {
        name: "salesforce-chatbot",
        version: "1.0.0"
      }
    });
    console.log('✅ MCP inicializado');

    // Obtener herramientas disponibles
    const toolsResponse = await sendMCPMessage('tools/list');
    mcpTools = toolsResponse.tools || [];
    
    console.log(`🛠️ Herramientas MCP disponibles: ${mcpTools.length}`);
    mcpTools.forEach(tool => {
      console.log(`   - ${tool.name}: ${tool.description}`);
    });

    return true;
  } catch (error) {
    console.error('❌ Error inicializando MCP Server:', error);
    return false;
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'SF Chatbot MCP Server - CLAUDE FULL POWER MODE',
    timestamp: new Date().toISOString(),
    claude_api: ANTHROPIC_API_KEY ? 'configured' : 'missing',
    mcp_server: mcpProcess ? 'running' : 'stopped',
    mcp_tools: mcpTools.length,
    available_tools: mcpTools.map(t => t.name),
    node_version: process.version,
    platform: process.platform,
    mode: 'FULL_INTELLIGENCE'
  });
});

// Endpoint principal del chatbot
app.post('/chat', async (req, res) => {
  try {
    const { question } = req.body;
    
    if (!question) {
      return res.status(400).json({ error: 'Pregunta requerida' });
    }

    console.log('📝 Pregunta recibida:', question);

    if (!ANTHROPIC_API_KEY) {
      return res.json({ 
        response: `[MODO BÁSICO] Pregunta: ${question}. Configura ANTHROPIC_API_KEY para acceso completo a Claude.`,
        mode: 'basic'
      });
    }

    if (!mcpProcess) {
      const connected = await initMCPServer();
      if (!connected) {
        return res.json({
          response: "❌ Error: No puedo conectar con Salesforce. Verifica las credenciales en las variables de entorno.",
          mode: 'error'
        });
      }
    }

    // Llamar a Claude con herramientas MCP
    const claudeResponse = await callClaudeWithMCP(question);
    
    res.json({ 
      response: claudeResponse,
      mode: 'full_claude_intelligence',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error en /chat:', error);
    res.status(500).json({ 
      error: `Error del servidor: ${error.message}`,
      fallback: `⚠️ Hubo un problema procesando tu pregunta: "${req.body.question}". Intenta de nuevo.`
    });
  }
});

// Función mejorada para llamar a Claude con MCP
async function callClaudeWithMCP(question) {
  try {
    console.log('🤖 Iniciando conversación con Claude (Modo Inteligencia Completa)...');
    
    // Convertir herramientas MCP al formato de Claude API
    const claudeTools = mcpTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema
    }));

    console.log(`🛠️ Enviando ${claudeTools.length} herramientas a Claude`);

    // Mensaje del sistema mejorado para comportarse como Claude completo
    const systemMessage = `Eres un asistente experto de Salesforce con acceso completo a herramientas MCP. 

INSTRUCCIONES CRÍTICAS:
1. Usa SIEMPRE las herramientas disponibles para obtener datos reales de Salesforce
2. Da respuestas completas, detalladas y útiles como lo haría Claude
3. Analiza los datos que obtienes y proporciona insights valiosos
4. Incluye números específicos, nombres, fechas y detalles relevantes
5. Si encuentras datos interesantes adicionales, compártelos también
6. Responde en español de forma profesional pero amigable
7. Si hay múltiples registros relevantes, menciona los más importantes
8. Nunca digas "no tengo información" sin antes usar las herramientas

FORMATO DE RESPUESTA:
- Respuesta directa a la pregunta
- Datos específicos y números exactos
- Contexto adicional relevante cuando sea útil
- Insights o recomendaciones si corresponde

Recuerda: Eres tan inteligente como Claude y debes dar respuestas de la misma calidad.`;

    // Mensajes iniciales
    let messages = [
      {
        role: 'user',
        content: question
      }
    ];

    // Primera llamada a Claude con modelo más potente
    let response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022', // Modelo más potente
        max_tokens: 4000, // Más tokens para respuestas completas
        temperature: 0.3, // Más preciso pero manteniendo naturalidad
        system: systemMessage,
        messages: messages,
        tools: claudeTools
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Claude API Error:', errorData);
      throw new Error(`Claude API error: ${response.status} - ${errorData}`);
    }

    let data = await response.json();
    console.log('📡 Respuesta inicial de Claude recibida');
    
    // Procesar tool calls iterativamente (como lo hace Claude real)
    let iterationCount = 0;
    const maxIterations = 5; // Prevenir loops infinitos
    
    while (data.content && data.content.some(item => item.type === 'tool_use') && iterationCount < maxIterations) {
      console.log(`🔧 Claude ejecutando herramientas (iteración ${iterationCount + 1})`);
      
      // Agregar respuesta de Claude a los mensajes
      messages.push({
        role: 'assistant',
        content: data.content
      });

      // Ejecutar tool calls
      const toolResults = [];
      
      for (const item of data.content) {
        if (item.type === 'tool_use') {
          console.log(`⚡ Ejecutando: ${item.name}`);
          console.log(`📝 Parámetros:`, JSON.stringify(item.input, null, 2));
          
          try {
            // Llamar a la herramienta vía JSON-RPC
            const result = await sendMCPMessage('tools/call', {
              name: item.name,
              arguments: item.input
            });
            
            console.log(`✅ Resultado de ${item.name} obtenido correctamente`);
            
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
                message: "Error ejecutando herramienta. Puede que los parámetros no sean correctos o que haya un problema de conectividad con Salesforce."
              }),
              is_error: true
            });
          }
        }
      }

      // Agregar resultados de herramientas
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
          max_tokens: 4000,
          temperature: 0.3,
          system: systemMessage,
          messages: messages,
          tools: claudeTools
        })
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Claude API error: ${response.status} - ${errorData}`);
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
      return 'Lo siento, no pude procesar tu consulta correctamente. ¿Podrías reformular tu pregunta?';
    }
    
    console.log('✅ Respuesta final generada correctamente');
    return finalText;
    
  } catch (error) {
    console.error('❌ Error en Claude + MCP:', error);
    return `❌ Error procesando tu consulta: ${error.message}. Por favor intenta de nuevo o verifica la conectividad con Salesforce.`;
  }
}

// Keepalive
app.get('/keepalive', (req, res) => {
  res.json({ 
    status: 'alive', 
    timestamp: new Date().toISOString(),
    mode: 'FULL_CLAUDE_INTELLIGENCE'
  });
});

// Cleanup al cerrar
process.on('SIGTERM', async () => {
  console.log('🔄 Cerrando conexiones...');
  if (mcpProcess) {
    mcpProcess.kill();
  }
  process.exit(0);
});

// Inicializar servidor
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔑 Claude API: ${ANTHROPIC_API_KEY ? 'Configurado ✅' : 'Faltante ❌'}`);
  console.log(`⚡ Modo: CLAUDE FULL INTELLIGENCE`);
  console.log(`🧠 Modelo: claude-3-5-sonnet-20241022`);
  console.log(`📦 Node version: ${process.version}`);
  console.log(`🌟 ¡Tu chatbot ahora tiene la inteligencia completa de Claude!`);
  
  // Inicializar MCP Server
  const connected = await initMCPServer();
  if (!connected) {
    console.log('⚠️ El servidor está funcionando pero MCP no está disponible');
    console.log('📋 Verifica las variables de entorno de Salesforce');
  } else {
    console.log('🎉 ¡Todo listo! Tu chatbot está funcionando con máxima inteligencia');
  }
});
