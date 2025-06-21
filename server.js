const express = require('express');
const { spawn } = require('child_process');
const app = express();

app.use(express.json());

// Variables de entorno
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// Verificar que tenemos todas las variables necesarias
const requiredEnvVars = [
  'SALESFORCE_USERNAME',
  'SALESFORCE_PASSWORD', 
  'SALESFORCE_TOKEN',
  'ANTHROPIC_API_KEY'
];

let mcpProcess = null;

// Inicializar MCP server
function initMCP() {
  console.log('🔧 Iniciando MCP server...');
  
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
    console.error('❌ Error en MCP process:', error);
  });

  mcpProcess.on('close', (code) => {
    console.log(`🔄 MCP process terminó con código ${code}`);
  });

  console.log('✅ MCP server iniciado');
}

// Health check
app.get('/', (req, res) => {
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  
  res.json({ 
    status: 'SF Chatbot MCP Server Running - Fase 2',
    timestamp: new Date().toISOString(),
    mcp_status: mcpProcess ? 'running' : 'stopped',
    claude_api: ANTHROPIC_API_KEY ? 'configured' : 'missing',
    missing_env_vars: missingVars.length > 0 ? missingVars : null
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

    // Verificar si tenemos Claude API configurada
    if (!ANTHROPIC_API_KEY) {
      return res.json({ 
        response: `[MODO BÁSICO] Pregunta: ${question}. Para inteligencia completa, configura ANTHROPIC_API_KEY.`,
        mode: 'basic'
      });
    }

    // Llamar a Claude API con herramientas MCP
    const claudeResponse = await callClaudeWithMCP(question);
    
    res.json({ 
      response: claudeResponse,
      mode: 'intelligent',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error en /chat:', error);
    res.status(500).json({ 
      error: `Error del servidor: ${error.message}`,
      fallback: `Pregunta recibida: ${req.body.question}. Servidor funcionando pero con error en procesamiento.`
    });
  }
});

// Función para llamar a Claude con MCP
async function callClaudeWithMCP(question) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ANTHROPIC_API_KEY}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-sonnet-20240229',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: `Eres un asistente especializado en Salesforce. Responde esta pregunta sobre datos de Salesforce: ${question}
            
Si necesitas consultar datos, usa las herramientas disponibles para hacer consultas SOQL.
Responde en español de forma amigable y útil.`
          }
        ],
        tools: [
          {
            "name": "salesforce_query_records",
            "description": "Ejecuta consultas SOQL en Salesforce",
            "input_schema": {
              "type": "object",
              "properties": {
                "objectName": {"type": "string"},
                "fields": {"type": "array", "items": {"type": "string"}},
                "whereClause": {"type": "string"},
                "limit": {"type": "number"}
              },
              "required": ["objectName", "fields"]
            }
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    // Extraer la respuesta de Claude
    if (data.content && data.content[0] && data.content[0].text) {
      return data.content[0].text;
    } else {
      return `Respuesta procesada para: ${question}. Claude conectado correctamente.`;
    }
    
  } catch (error) {
    console.error('❌ Error calling Claude:', error);
    throw new Error(`Error de Claude API: ${error.message}`);
  }
}

// Keepalive endpoint para evitar que se duerma
app.get('/keepalive', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Inicializar servidor
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔑 Claude API: ${ANTHROPIC_API_KEY ? 'Configurado' : 'Faltante'}`);
  
  // Inicializar MCP solo si tenemos las credenciales de SF
  const hasSFCredentials = process.env.SALESFORCE_USERNAME && 
                          process.env.SALESFORCE_PASSWORD && 
                          process.env.SALESFORCE_TOKEN;
  
  if (hasSFCredentials) {
    initMCP();
  } else {
    console.log('⚠️  Credenciales de Salesforce faltantes, MCP no iniciado');
  }
});
