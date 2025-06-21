const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

let mcpClient = null;
let mcpTools = [];
let mcpProcess = null;

// ——————————————
// 1) Carga del SDK MCP desde dist
// ——————————————
let Client, StdioClientTransport;
try {
  // Resolvemos la ruta del package.json del SDK
  const sdkRoot = path.dirname(require.resolve('@modelcontextprotocol/sdk/package.json'));
  const sdk = require(path.join(sdkRoot, 'dist/client/index.js'));
  Client = sdk.Client;
  StdioClientTransport = sdk.StdioClientTransport;
  console.log('✅ MCP SDK cargado desde dist/client/index.js');
} catch (err) {
  console.error('❌ No pude cargar MCP SDK desde dist:', err);
  process.exit(1);
}

// ——————————————
// 2) Inicialización del cliente MCP
// ——————————————
async function initMCPClient() {
  try {
    console.log('🔧 Iniciando MCP Client...');

    mcpProcess = spawn('npx', ['-y', '@tsmztech/mcp-server-salesforce'], {
      env: {
        ...process.env,
        SALESFORCE_CONNECTION_TYPE: process.env.SALESFORCE_CONNECTION_TYPE || "User_Password",
        SALESFORCE_USERNAME: process.env.SALESFORCE_USERNAME,
        SALESFORCE_PASSWORD: process.env.SALESFORCE_PASSWORD,
        SALESFORCE_TOKEN: process.env.SALESFORCE_TOKEN,
        SALESFORCE_INSTANCE_URL: process.env.SALESFORCE_INSTANCE_URL || "https://login.salesforce.com"
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    mcpProcess.on('error', e => console.error('❌ Error en proceso MCP:', e));
    mcpProcess.stderr.on('data', d => console.error('⚠️ MCP Server stderr:', d.toString()));

    const transport = new StdioClientTransport({
      stdin: mcpProcess.stdin,
      stdout: mcpProcess.stdout,
      stderr: mcpProcess.stderr
    });

    mcpClient = new Client(
      { name: "salesforce-chatbot", version: "1.0.0" },
      { capabilities: {} }
    );
    await mcpClient.connect(transport);
    console.log('✅ MCP Client conectado');

    const toolsResp = await mcpClient.listTools();
    mcpTools = toolsResp.tools || [];
    console.log(`🛠️ Herramientas MCP disponibles: ${mcpTools.length}`);
    mcpTools.forEach(t => console.log(`   - ${t.name}: ${t.description}`));

    return true;
  } catch (error) {
    console.error('❌ Error inicializando MCP Client:', error);
    return false;
  }
}

// ——————————————
// 3) Health check
// ——————————————
app.get('/', (_req, res) => {
  res.json({
    status:         'SF Chatbot MCP Server - PROTOCOL COMPLETO',
    timestamp:      new Date().toISOString(),
    claude_api:     ANTHROPIC_API_KEY ? 'configured' : 'missing',
    mcp_client:     mcpClient    ? 'connected' : 'disconnected',
    mcp_tools:      mcpTools.length,
    available_tools: mcpTools.map(t => t.name),
    node_version:   process.version,
    platform:       process.platform
  });
});

// ——————————————
// 4) Endpoint /chat
// ——————————————
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
      const ok = await initMCPClient();
      if (!ok) {
        return res.json({
          response: "Error: No puedo conectar con MCP. Verifica las credenciales de Salesforce.",
          mode: 'error'
        });
      }
    }

    const answer = await callClaudeWithRealMCP(question);
    res.json({
      response:  answer,
      mode:      'mcp_protocol',
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('❌ Error en /chat:', err);
    res.status(500).json({
      error:    `Error del servidor: ${err.message}`,
      fallback: `Pregunta: ${req.body.question}`
    });
  }
});

// ——————————————
// 5) Lógica para llamar a Claude + MCP
// ——————————————
async function callClaudeWithRealMCP(question) {
  try {
    console.log('🤖 Iniciando conversación con Claude + MCP…');

    const claudeTools = mcpTools.map(t => ({
      name:         t.name,
      description:  t.description,
      input_schema: t.inputSchema
    }));

    let messages = [{
      role: 'user',
      content: `Soy un asistente de Salesforce. Responde esta pregunta usando las herramientas disponibles: "${question}"

Usa las herramientas para obtener datos reales de Salesforce.
Responde en español de forma directa con información específica.`
    }];

    // Usamos fetch global de Node 20+
    let resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-3-haiku-20240307',
        max_tokens: 1500,
        messages,
        tools:      claudeTools
      })
    });

    if (!resp.ok) {
      const errTxt = await resp.text();
      throw new Error(`Claude API error: ${resp.status} – ${errTxt}`);
    }

    let data = await resp.json();
    console.log('📡 Respuesta inicial de Claude recibida');

    // Iteramos si Claude decide usar herramientas MCP
    while (data.content?.some(item => item.type === 'tool_use')) {
      console.log('🔧 Claude quiere usar herramientas');
      messages.push({ role: 'assistant', content: data.content });

      const toolResults = [];
      for (let item of data.content) {
        if (item.type === 'tool_use') {
          console.log(`⚡ Ejecutando ${item.name}`, item.input);
          try {
            const result = await mcpClient.callTool(item.name, item.input);
            toolResults.push({
              type:         'tool_result',
              tool_use_id:  item.id,
              content:      JSON.stringify(result.content)
            });
          } catch (toolErr) {
            toolResults.push({
              type:         'tool_result',
              tool_use_id:  item.id,
              content:      JSON.stringify({ error: toolErr.message }),
              is_error:     true
            });
          }
        }
      }

      messages.push({ role: 'user', content: toolResults });

      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':     'application/json',
          'x-api-key':         ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model:      'claude-3-haiku-20240307',
          max_tokens: 1500,
          messages,
          tools:      claudeTools
        })
      });

      if (!resp.ok) {
        const errTxt = await resp.text();
        throw new Error(`Claude API error: ${resp.status} – ${errTxt}`);
      }
      data = await resp.json();
      console.log('📡 Nueva respuesta de Claude recibida');
    }

    // Extraer sólo el texto final
    return (data.content || [])
      .filter(i => i.type === 'text')
      .map(i => i.text)
      .join(' ')
      || 'Error procesando respuesta final';

  } catch (error) {
    console.error('❌ Error en Claude + MCP real:', error);
    throw error;
  }
}

// ——————————————
// 6) Keepalive & limpieza
// ——————————————
app.get('/keepalive', (_req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

process.on('SIGTERM', async () => {
  console.log('🔄 Cerrando conexiones…');
  if (mcpClient)  await mcpClient.close();
  if (mcpProcess) mcpProcess.kill();
  process.exit(0);
});

// ——————————————
// 7) Arranque del servidor
// ——————————————
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔑 Claude API: ${ANTHROPIC_API_KEY ? 'Configurado' : 'Faltante'}`);
  console.log(`⚡ Modo: MCP PROTOCOL COMPLETO`);
  console.log(`📦 Node version: ${process.version}`);

  const ok = await initMCPClient();
  if (!ok) console.log('⚠️ El servidor está funcionando pero MCP no está disponible');
});
