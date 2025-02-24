const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(client);

/**
 * Lambda handler function for processing subscription webhook events
 * @param {object} event - Incoming webhook payload
 * @returns {object} - Operation result or error response
 */
exports.handler = async (event) => {
  try {
    const webhookData = event;
    console.log("Webhook Data:", webhookData);
    const { attributes } = webhookData.data;
    console.log("attributes:", attributes);
    console.log("id:", webhookData.data.id);

    if (!attributes?.user_email || !webhookData.data.id) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "user_email y subscriptionId son requeridos",
        }),
      };
    }

    const subscriptionData = {
      email: attributes.user_email,
      subscriptionId: webhookData.data.id,
      status: attributes.status,
      plan: attributes.variant_name,
      startDate: attributes.created_at,
      endDate: attributes.renews_at,
      cancelled: attributes.cancelled,
      endsAt: attributes.ends_at,
    };

    const updateParams = buildDynamoParams(subscriptionData);

    const command = new UpdateCommand(updateParams);
    const result = await docClient.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({
        operation: result.Attributes ? "updated" : "created",
        metadata: {
          subscriptionId: subscriptionData.subscriptionId,
          status: subscriptionData.status,
          nextBillingDate: subscriptionData.endDate,
        },
      }),
    };
  } catch (error) {
    console.error("Error:", error);
    return handleDynamoError(error);
  }
};

/**
 * Constructs DynamoDB update parameters based on subscription data
 * Uses composite primary key: userId (email) + subscriptionId
 * Dynamically builds update expression based on available data
 * @param {object} data - Normalized subscription data
 * @returns {object} - DynamoDB UpdateCommand parameters
 */
const buildDynamoParams = (data) => {
  const userId = String(data.email);
  const subscriptionId = String(data.subscriptionId);

  console.log("Valores de clave recibidos:", {
    userId: data.email,
    subscriptionId: data.subscriptionId,
    data: data,
    types: {
      userIdType: typeof data.email,
      subscriptionIdType: typeof data.subscriptionId,
    },
  });

  const params = {
    TableName: process.env.TABLE_NAME,
    Key: {
      userId: userId,
      subscriptionId: subscriptionId,
    },
    UpdateExpression:
      "SET #st = :status, endDate = :end, cancelled = :cancelled",
    ConditionExpression:
      "attribute_not_exists(subscriptionId) OR #st <> :status",
    ExpressionAttributeNames: {
      "#st": "status",
      "#pl": "plan",
    },
    ExpressionAttributeValues: {
      ":status": data.status,
      ":end": data.endDate,
      ":cancelled": data.cancelled,
    },
    ReturnValues: "UPDATED_NEW",
  };

  if (data.plan) {
    params.UpdateExpression += ", #pl = :plan";
    params.ExpressionAttributeValues[":plan"] = data.plan;
  }

  if (data.startDate) {
    params.UpdateExpression += ", startDate = :start";
    params.ExpressionAttributeValues[":start"] = data.startDate;
  }

  return params;
};

/**
 * Handles DynamoDB errors and formats appropriate responses
 * Special case: Treat ConditionalCheckFailed as success (no changes needed)
 * @param {Error} error - Thrown error object
 * @returns {object} - Formatted error response
 */
const handleDynamoError = (error) => {
  const errorResponse = {
    statusCode: 500,
    body: JSON.stringify({ error: "Error interno del servidor" }),
  };

  if (error.name === "ConditionalCheckFailedException") {
    errorResponse.statusCode = 200;
    errorResponse.body = JSON.stringify({
      status: "no-changes",
      message: "La suscripción ya está actualizada",
    });
  }

  return errorResponse;
};
