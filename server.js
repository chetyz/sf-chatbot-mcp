const express = require('express');
const { spawn } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio');

const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

let mcpClient = null;
let mcpTools = [];
let mcpProcess = null;

// Inicializar MCP Client completo
async function initMCPClient() {
  try {
    console.log('🔧 Iniciando MCP Client...');
    
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

    // Crear transport stdio
    const transport = new StdioClientTransport({
      stdin: mcpProcess.stdin,
      stdout: mcpProcess.stdout,
      stderr: mcpProcess.stderr
    });

    // Crear MCP client
    mcpClient = new Client({
      name: "salesforce-chatbot",
      version: "1.0.0"
    }, {
      capabilities: {}
    });

    // Conectar
    await mcpClient.connect(transport);
    console.log('✅ MCP Client conectado');

    // Obtener herramientas disponibles
    const toolsResponse = await mcpClient.listTools();
    mcpTools = toolsResponse.tools || [];
    
    console.log(`🛠️ Herramientas MCP disponibles: ${mcpTools.length}`);
    mcpTools.forEach(tool => {
      console.log(`   - ${tool.name}: ${tool.description}`);
    });

    return true;
  } catch (error) {
    console.error('❌ Error inicializando MCP Client:', error);
    return false;
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'SF Chatbot MCP Server - PROTOCOL COMPLETO',
    timestamp: new Date().toISOString(),
    claude_api: ANTHROPIC_API_KEY ? 'configured' : 'missing',
    mcp_client: mcpClient ? 'connected' : 'disconnected',
    mcp_tools: mcpTools.length,
    available_tools: mcpTools.map(t => t.name)
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
        response: `[MODO BÁSICO] Pregunta: ${question}. Configura ANTHROPIC_API_KEY.`,
        mode: 'basic'
      });
    }

    if (!mcpClient) {
      const connected = await initMCPClient();
      if (!connected) {
        return res.json({
          response: "Error: No puedo conectar con MCP. Verifica las credenciales de Salesforce.",
          mode: 'error'
        });
      }
    }

    // Llamar a Claude con herramientas MCP reales
    const claudeResponse = await callClaudeWithRealMCP(question);
    
    res.json({ 
      response: claudeResponse,
      mode: 'mcp_protocol',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error en /chat:', error);
    res.status(500).json({ 
      error: `Error del servidor: ${error.message}`,
      fallback: `Pregunta recibida: ${req.body.question}.`
    });
  }
});

// Función para llamar a Claude con MCP protocol real
async function callClaudeWithRealMCP(question) {
  try {
    console.log('🤖 Iniciando conversación con Claude + MCP...');
    
    // Convertir herramientas MCP al formato de Claude API
    const claudeTools = mcpTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema
    }));

    console.log(`🛠️ Enviando ${claudeTools.length} herramientas a Claude`);

    // Primera llamada a Claude
    let messages = [
      {
        role: 'user',
        content: `Soy un asistente de Salesforce. Responde esta pregunta usando las herramientas disponibles: "${question}"

Usa las herramientas para obtener datos reales de Salesforce.
Responde en español de forma directa con información específica.`
      }
    ];

    let response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1500,
        messages: messages,
        tools: claudeTools
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }

    let data = await response.json();
    console.log('📡 Respuesta inicial de Claude recibida');
    
    // Procesar tool calls si existen
    while (data.content && data.content.some(item => item.type === 'tool_use')) {
      console.log('🔧 Claude quiere usar herramientas');
      
      // Agregar respuesta de Claude a los mensajes
      messages.push({
        role: 'assistant',
        content: data.content
      });

      // Ejecutar tool calls
      const toolResults = [];
      
      for (const item of data.content) {
        if (item.type === 'tool_use') {
          console.log(`⚡ Ejecutando: ${item.name} con:`, item.input);
          
          try {
            // Usar MCP Client real para ejecutar la herramienta
            const result = await mcpClient.callTool(item.name, item.input);
            
            console.log(`✅ Resultado de ${item.name}:`, result);
            
            toolResults.push({
              type: 'tool_result',
              tool_use_id: item.id,
              content: JSON.stringify(result.content)
            });
          } catch (toolError) {
            console.error(`❌ Error ejecutando ${item.name}:`, toolError);
            
            toolResults.push({
              type: 'tool_result',
              tool_use_id: item.id,
              content: JSON.stringify({ error: toolError.message }),
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
          model: 'claude-3-haiku-20240307',
          max_tokens: 1500,
          messages: messages,
          tools: claudeTools
        })
      });

      if (!response.ok) {
        throw new Error(`Claude API error: ${response.status}`);
      }

      data = await response.json();
      console.log('📡 Nueva respuesta de Claude recibida');
    }
    
    // Extraer respuesta final
    const finalText = data.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join(' ');
    
    return finalText || 'Error procesando respuesta final';
    
  } catch (error) {
    console.error('❌ Error en Claude + MCP real:', error);
    throw error;
  }
}

// Keepalive
app.get('/keepalive', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Cleanup al cerrar
process.on('SIGTERM', async () => {
  console.log('🔄 Cerrando conexiones...');
  if (mcpClient) {
    await mcpClient.close();
  }
  if (mcpProcess) {
    mcpProcess.kill();
  }
  process.exit(0);
});

// Inicializar servidor
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔑 Claude API: ${ANTHROPIC_API_KEY ? 'Configurado' : 'Faltante'}`);
  console.log(`⚡ Modo: MCP PROTOCOL COMPLETO`);
  
  // Inicializar MCP Client
  await initMCPClient();
});
