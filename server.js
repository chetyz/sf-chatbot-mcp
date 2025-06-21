const express = require('express');
const jsforce = require('jsforce');
const app = express();

app.use(express.json());

// Variables de entorno
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3000;

// Conexión Salesforce
let sfConnection = null;

// Inicializar conexión Salesforce
async function initSalesforceConnection() {
  try {
    console.log('🔗 Conectando a Salesforce...');
    
    sfConnection = new jsforce.Connection({
      loginUrl: process.env.SALESFORCE_INSTANCE_URL || 'https://login.salesforce.com'
    });
    
    await sfConnection.login(
      process.env.SALESFORCE_USERNAME,
      process.env.SALESFORCE_PASSWORD + process.env.SALESFORCE_TOKEN
    );
    
    console.log('✅ Conexión Salesforce exitosa');
    return true;
  } catch (error) {
    console.error('❌ Error conectando Salesforce:', error);
    return false;
  }
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'SF Chatbot MCP Server - DIRECT TOOLS',
    timestamp: new Date().toISOString(),
    claude_api: ANTHROPIC_API_KEY ? 'configured' : 'missing',
    salesforce: sfConnection ? 'connected' : 'disconnected',
    mode: 'direct_mcp_tools'
  });
});

// Función salesforce_query_records (igual que la tuya)
async function salesforce_query_records(objectName, fields, whereClause = null, orderBy = null, limit = null) {
  try {
    console.log('🔍 Ejecutando salesforce_query_records...');
    
    let soql = `SELECT ${fields.join(', ')} FROM ${objectName}`;
    if (whereClause) soql += ` WHERE ${whereClause}`;
    if (orderBy) soql += ` ORDER BY ${orderBy}`;
    if (limit) soql += ` LIMIT ${limit}`;
    
    console.log('📊 SOQL:', soql);
    
    const result = await sfConnection.query(soql);
    
    console.log(`✅ Query exitoso: ${result.totalSize} registros`);
    
    return {
      success: true,
      records: result.records,
      totalSize: result.totalSize,
      soql: soql
    };
    
  } catch (error) {
    console.error('❌ Error en query:', error);
    return {
      success: false,
      error: error.message,
      soql: soql
    };
  }
}

// Función salesforce_aggregate_query (para COUNT, SUM, etc.)
async function salesforce_aggregate_query(objectName, selectFields, groupByFields, whereClause = null, havingClause = null, limit = null) {
  try {
    console.log('📈 Ejecutando salesforce_aggregate_query...');
    
    let soql = `SELECT ${selectFields.join(', ')} FROM ${objectName}`;
    if (whereClause) soql += ` WHERE ${whereClause}`;
    if (groupByFields && groupByFields.length > 0) soql += ` GROUP BY ${groupByFields.join(', ')}`;
    if (havingClause) soql += ` HAVING ${havingClause}`;
    if (limit) soql += ` LIMIT ${limit}`;
    
    console.log('📊 SOQL Aggregate:', soql);
    
    const result = await sfConnection.query(soql);
    
    console.log(`✅ Aggregate query exitoso: ${result.totalSize} registros`);
    
    return {
      success: true,
      records: result.records,
      totalSize: result.totalSize,
      soql: soql
    };
    
  } catch (error) {
    console.error('❌ Error en aggregate query:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

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

    if (!sfConnection) {
      const connected = await initSalesforceConnection();
      if (!connected) {
        return res.json({
          response: "Error: No puedo conectar con Salesforce. Verifica las credenciales.",
          mode: 'error'
        });
      }
    }

    // Llamar a Claude con herramientas MCP
    const claudeResponse = await callClaudeWithMCPTools(question);
    
    res.json({ 
      response: claudeResponse,
      mode: 'mcp_tools',
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

// Función principal con herramientas MCP
async function callClaudeWithMCPTools(question) {
  try {
    console.log('🤖 Llamando Claude con herramientas MCP...');
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1500,
        messages: [
          {
            role: 'user',
            content: `Soy un asistente de Salesforce. Responde esta pregunta: "${question}"

Usa las herramientas disponibles para consultar datos reales de Salesforce.
Responde en español de forma directa con los datos específicos.`
          }
        ],
        tools: [
          {
            "name": "salesforce_query_records",
            "description": "Query records from any Salesforce object using SOQL",
            "input_schema": {
              "type": "object",
              "properties": {
                "objectName": {"type": "string", "description": "API name of the object to query"},
                "fields": {"type": "array", "items": {"type": "string"}, "description": "List of fields to retrieve"},
                "whereClause": {"type": "string", "description": "WHERE clause, can include conditions on related objects"},
                "orderBy": {"type": "string", "description": "ORDER BY clause"},
                "limit": {"type": "number", "description": "Maximum number of records to return"}
              },
              "required": ["objectName", "fields"]
            }
          },
          {
            "name": "salesforce_aggregate_query", 
            "description": "Execute SOQL queries with GROUP BY, aggregate functions, and statistical analysis",
            "input_schema": {
              "type": "object",
              "properties": {
                "objectName": {"type": "string", "description": "API name of the object to query"},
                "selectFields": {"type": "array", "items": {"type": "string"}, "description": "Fields to select - mix of group fields and aggregates"},
                "groupByFields": {"type": "array", "items": {"type": "string"}, "description": "Fields to group by"},
                "whereClause": {"type": "string", "description": "WHERE clause to filter rows BEFORE grouping"},
                "havingClause": {"type": "string", "description": "HAVING clause to filter results AFTER grouping"},
                "limit": {"type": "number", "description": "Maximum number of grouped results to return"}
              },
              "required": ["objectName", "selectFields"]
            }
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = await response.json();
    console.log('📡 Claude response received');
    
    // Procesar tool calls
    if (data.content && data.content.some(item => item.type === 'tool_use')) {
      console.log('🛠️ Claude quiere usar herramientas');
      
      let toolResults = [];
      let textContent = '';
      
      for (const item of data.content) {
        if (item.type === 'tool_use') {
          console.log(`🔧 Ejecutando: ${item.name}`);
          
          let result;
          if (item.name === 'salesforce_query_records') {
            result = await salesforce_query_records(
              item.input.objectName,
              item.input.fields,
              item.input.whereClause,
              item.input.orderBy,
              item.input.limit
            );
          } else if (item.name === 'salesforce_aggregate_query') {
            result = await salesforce_aggregate_query(
              item.input.objectName,
              item.input.selectFields,
              item.input.groupByFields,
              item.input.whereClause,
              item.input.havingClause,
              item.input.limit
            );
          }
          
          toolResults.push({
            tool_use_id: item.id,
            content: JSON.stringify(result)
          });
        } else if (item.type === 'text') {
          textContent += item.text;
        }
      }
      
      // Segunda llamada a Claude con resultados
      const followUpResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 1500,
          messages: [
            {
              role: 'user',
              content: `Responde esta pregunta: "${question}"`
            },
            {
              role: 'assistant',
              content: data.content
            },
            {
              role: 'user',
              content: toolResults.map(r => ({
                type: 'tool_result',
                tool_use_id: r.tool_use_id,
                content: r.content
              }))
            }
          ]
        })
      });
      
      const followUpData = await followUpResponse.json();
      return followUpData.content[0]?.text || 'Error procesando resultados';
      
    } else {
      // Respuesta directa
      return data.content[0]?.text || 'Error procesando respuesta';
    }
    
  } catch (error) {
    console.error('❌ Error en Claude + MCP tools:', error);
    throw error;
  }
}

// Inicializar servidor
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔑 Claude API: ${ANTHROPIC_API_KEY ? 'Configurado' : 'Faltante'}`);
  console.log(`⚡ Modo: HERRAMIENTAS MCP DIRECTAS`);
  
  // Conectar a Salesforce al inicio
  await initSalesforceConnection();
});
