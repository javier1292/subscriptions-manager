const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const dynamoClient = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: true,
  },
});
const sesClient = new SESClient();

const BATCH_SIZE = 25; // Límite para envío de emails en paralelo

// Validar variables de entorno al iniciar
const requiredEnvVars = ["TABLE_NAME", "SES_EMAIL"];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`Variable de entorno requerida no configurada: ${varName}`);
  }
});

/**
 * Función para consultar suscripciones próximas a expirar
 * @param {string} thresholdDate - Fecha límite en formato ISO
 * @param {string} tableName - Nombre de la tabla DynamoDB
 * @returns {Promise<Array>} - Lista de suscripciones
 */
async function queryExpiringSubscriptions(thresholdDate, tableName) {
  const subscriptions = [];
  let lastEvaluatedKey = null;

  do {
    const params = {
      TableName: tableName,
      IndexName: "status-endDate-index",
      KeyConditionExpression: "#status = :status AND endDate <= :threshold",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "active",
        ":threshold": thresholdDate,
      },
      ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
    };

    console.log(
      "Consultando DynamoDB con parámetros:",
      JSON.stringify(params, null, 2)
    );

    const response = await docClient.send(new QueryCommand(params));

    // Procesar y validar items
    if (response.Items && response.Items.length > 0) {
      const validItems = response.Items.filter(
        (item) => item?.userId && item?.subscriptionId && item?.endDate
      ).map((item) => ({
        userId: String(item.userId),
        subscriptionId: String(item.subscriptionId),
        endDate: String(item.endDate),
      }));

      subscriptions.push(...validItems);
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return subscriptions;
}

/**
 * Envía emails en lotes para evitar sobrecargar el servicio
 * @param {Array} subscriptions - Lista de suscripciones
 * @param {string} senderEmail - Email del remitente
 * @returns {Promise<Object>} - Resultados del envío
 */
async function sendEmailsInBatches(subscriptions, senderEmail) {
  const results = {
    total: subscriptions.length,
    success: 0,
    failed: 0,
    errors: [],
  };

  // Procesar en lotes para no sobrecargar SES
  for (let i = 0; i < subscriptions.length; i += BATCH_SIZE) {
    const batch = subscriptions.slice(i, i + BATCH_SIZE);

    const batchPromises = batch.map(async (sub) => {
      try {
        const emailParams = {
          Source: senderEmail,
          Destination: { ToAddresses: [sub.userId] },
          Message: {
            Subject: { Data: "Última oportunidad de renovación" },
            Body: {
              Text: {
                Data: `Tu suscripción (ID: ${
                  sub.subscriptionId
                }) expirará el ${new Date(sub.endDate).toLocaleDateString(
                  "es-ES"
                )}. Renueva ahora para continuar disfrutando de nuestros servicios.`,
              },
              Html: {
                Data: `
                  <html>
                    <body>
                      <h2>Tu suscripción está por expirar</h2>
                      <p>Estimado cliente,</p>
                      <p>Tu suscripción (ID: <strong>${
                        sub.subscriptionId
                      }</strong>) expirará el <strong>${new Date(
                  sub.endDate
                ).toLocaleDateString("es-ES")}</strong>.</p>
                      <p>Renueva ahora para continuar disfrutando de nuestros servicios sin interrupciones.</p>
                      <a href="https://tudominio.com/renovar?id=${
                        sub.subscriptionId
                      }" style="background-color: #4CAF50; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px;">Renovar ahora</a>
                      <p>Si tienes alguna pregunta, no dudes en contactarnos.</p>
                      <p>Saludos cordiales,<br>El equipo de soporte</p>
                    </body>
                  </html>
                `,
              },
            },
          },
        };

        await sesClient.send(new SendEmailCommand(emailParams));
        console.log(
          `Email enviado exitosamente a: ${sub.userId} para la suscripción ${sub.subscriptionId}`
        );
        results.success++;
        return true;
      } catch (error) {
        console.error(`Error al enviar email a ${sub.userId}:`, error);
        results.failed++;
        results.errors.push({
          userId: sub.userId,
          subscriptionId: sub.subscriptionId,
          error: error.message,
        });
        return false;
      }
    });

    await Promise.all(batchPromises);

    // Pequeña pausa entre lotes para evitar límites de tasa
    if (i + BATCH_SIZE < subscriptions.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return results;
}

module.exports.handler = async (event, context) => {
  console.log("Iniciando función de notificación de renovaciones", {
    requestId: context?.awsRequestId,
    timestamp: new Date().toISOString(),
  });

  try {
    // Validar variables de entorno
    if (!process.env.TABLE_NAME || !process.env.SES_EMAIL) {
      throw new Error(
        "Variables de entorno requeridas no configuradas: TABLE_NAME o SES_EMAIL"
      );
    }

    // Configurar fecha límite (subscripciones que expiran en los próximos 3 días)
    const thresholdDate = new Date();
    thresholdDate.setUTCDate(thresholdDate.getUTCDate() + 3);
    const thresholdISOString = thresholdDate.toISOString();

    console.log(
      `Buscando suscripciones que expiran antes de: ${thresholdISOString}`
    );

    // Consultar suscripciones próximas a expirar
    const subscriptions = await queryExpiringSubscriptions(
      thresholdISOString,
      process.env.TABLE_NAME
    );
    console.log(
      `Se encontraron ${subscriptions.length} suscripciones próximas a expirar`
    );

    // Enviar emails si hay suscripciones
    if (subscriptions.length > 0) {
      const results = await sendEmailsInBatches(
        subscriptions,
        process.env.SES_EMAIL
      );

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: `Proceso completado. Se enviaron ${results.success} notificaciones de un total de ${results.total}`,
          resultados: results,
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "No se encontraron suscripciones próximas a expirar",
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (error) {
    console.error("Error crítico:", {
      timestamp: new Date().toISOString(),
      error: error.message,
      stack: error.stack,
      requestId: context?.awsRequestId,
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Error en el servicio de notificación de renovaciones",
        mensaje: error.message,
        referencia:
          context?.awsRequestId || Math.random().toString(36).substring(2, 9),
        timestamp: new Date().toISOString(),
      }),
    };
  }
};
