import {
  DynamoDBClient,
  ScanCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const dynamoClient = new DynamoDBClient({});
const sqsClient = new SQSClient({});
const secretsClient = new SecretsManagerClient({});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getSecrets() {
  const command = new GetSecretValueCommand({
    SecretId: "bulkTransferSecredt",
  });

  const response = await secretsClient.send(command);

  const secret = JSON.parse(response.SecretString);

  return secret;
}

const MAX_RETRIES = 3;

const retryFetch = async (url, options, attempt = 1) => {
  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      if (
        attempt <= MAX_RETRIES &&
        [429, 500, 502, 503, 504].includes(response.status)
      ) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(
          `Retrying request (Attempt ${attempt}) after ${delay}ms due to status ${response.status}`,
        );
        await sleep(delay);
        return retryFetch(url, options, attempt + 1);
      }

      throw new Error(await response.text());
    }

    return response;
  } catch (err) {
    if (attempt <= MAX_RETRIES) {
      const delay = 1000 * Math.pow(2, attempt);
      console.warn(
        `Network error. Retrying attempt ${attempt} after ${delay}ms`,
      );
      await sleep(delay);
      return retryFetch(url, options, attempt + 1);
    }

    throw err;
  }
};

const sendToDLQ = async (record, errorMessage) => {
  try {
    const messageBody = {
      failedRecord: record,
      error: errorMessage,
      timestamp: new Date().toISOString(),
    };

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: DLQ_URL,
        MessageBody: JSON.stringify(messageBody),
      }),
    );

    console.log("Record sent to DLQ:", record.externalId);
  } catch (err) {
    console.error("Failed to send message to DLQ:", err);
  }
};

export const handler = async () => {
  console.log("Lambda triggered manually.");
  const secrets = await getSecrets();

  const SF_CLIENT_ID = secrets.SF_CLIENT_ID;
  const SF_CLIENT_SECRET = secrets.SF_CLIENT_SECRET;
  const SF_TOKEN_URL = secrets.SF_TOKEN_URL;
  const SF_API_VERSION = secrets.SF_API_VERSION;
  const DYNAMO_TABLE_NAME = secrets.DYNAMO_TABLE_NAME;
  const DLQ_URL = secrets.DLQ_URL;

  let allItems = [];
  let lastEvaluatedKey = undefined;

  do {
    const scanResult = await dynamoClient.send(
      new ScanCommand({
        TableName: DYNAMO_TABLE_NAME,
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    const items = scanResult.Items.map((item) => unmarshall(item));
    allItems = allItems.concat(items);
    lastEvaluatedKey = scanResult.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`Total records fetched from DynamoDB: ${allItems.length}`);

  if (allItems.length === 0) {
    console.log("No records to process.");
    return { statusCode: 200, body: "No records found." };
  }

  const headers = [
    "Platform_Shooper_Id__c",
    "FirstName",
    "LastName",
    "Email",
    "MobilePhone",
  ];

  const recordsToUpsert = allItems.map((item) => ({
    Platform_Shooper_Id__c: item.externalId,
    FirstName: item.FirstName,
    LastName: item.LastName,
    Email: item.Email,
    MobilePhone: item.Mobile,
  }));

  const csvData = [
    headers.join(","),
    ...recordsToUpsert.map((r) => headers.map((f) => r[f] ?? "").join(",")),
  ].join("\n");

  console.log("CSV generated.");

  try {
    const authResponse = await retryFetch(SF_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: SF_CLIENT_ID,
        client_secret: SF_CLIENT_SECRET,
      }),
    });

    if (!authResponse.ok)
      throw new Error(`Auth Failed: ${await authResponse.text()}`);

    const { access_token: accessToken, instance_url: instanceUrl } =
      await authResponse.json();
    console.log("Salesforce authentication successful.");

    const jobResponse = await retryFetch(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          object: "Contact",
          operation: "upsert",
          externalIdFieldName: "Platform_Shooper_Id__c",
          contentType: "CSV",
        }),
      },
    );

    if (!jobResponse.ok)
      throw new Error(`Job Creation Failed: ${await jobResponse.text()}`);

    const { id: jobId } = await jobResponse.json();
    console.log("Bulk Job Created. Job ID:", jobId);

    const uploadResponse = await retryFetch(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/batches`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "text/csv",
        },
        body: csvData,
      },
    );

    if (!uploadResponse.ok)
      throw new Error(`CSV Upload Failed: ${await uploadResponse.text()}`);
    console.log("CSV uploaded successfully.");

    await retryFetch(
      `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state: "UploadComplete" }),
      },
    );
    console.log("Job marked as UploadComplete.");

    let jobStatus;
    for (let attempt = 1; attempt <= 10; attempt++) {
      console.log(`Checking job status... Attempt ${attempt}`);

      const statusResponse = await retryFetch(
        `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      jobStatus = await statusResponse.json();
      console.log("Current Job State:", jobStatus.state);

      if (["JobComplete", "Failed", "Aborted"].includes(jobStatus.state)) break;

      await sleep(3000);
    }

    console.log("Final Job State:", jobStatus.state);
    console.log("Success Count:", jobStatus.numberRecordsProcessed);
    console.log("Failure Count:", jobStatus.numberRecordsFailed);

    if (jobStatus.numberRecordsFailed > 0) {
      const failedResponse = await retryFetch(
        `${instanceUrl}/services/data/${SF_API_VERSION}/jobs/ingest/${jobId}/failedResults`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      const failedCSV = await failedResponse.text();
      console.log("Failed Records CSV:", failedCSV);

      const rows = failedCSV.split("\n").slice(1);

      for (const row of rows) {
        if (!row.trim()) continue;

        const values = row.split(",");
        const failedRecord = {
          Platform_Shooper_Id__c: values[0],
          FirstName: values[1],
          LastName: values[2],
          Email: values[3],
          MobilePhone: values[4],
          error: values[5],
        };

        await sendToDLQ(failedRecord, "Salesforce upsert failed");
      }
    }

    if (jobStatus.state === "JobComplete") {
      console.log("Deleting all records from DynamoDB...");

      for (const item of allItems) {
        await dynamoClient.send(
          new DeleteItemCommand({
            TableName: DYNAMO_TABLE_NAME,
            Key: { externalId: { S: String(item.externalId) } },
          }),
        );
      }

      console.log(`Deleted ${allItems.length} records from DynamoDB.`);
    } else {
      console.warn(
        "Job did not complete successfully — skipping DynamoDB deletion.",
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        jobId,
        successCount: jobStatus.numberRecordsProcessed,
        failureCount: jobStatus.numberRecordsFailed,
        state: jobStatus.state,
        deletedFromDynamo:
          jobStatus.state === "JobComplete" ? allItems.length : 0,
      }),
    };
  } catch (error) {
    console.error("Error occurred:", error.message);
    throw error;
  }
};
