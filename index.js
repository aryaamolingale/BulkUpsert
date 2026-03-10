import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({ region: "us-east-1" });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = "CustomerInteractions";

async function insertDummyData() {
  const insertPromises = [];

  for (let i = 2000; i <= 2200; i++) {
    const item = {
      externalId: `ext${i}`,
      Email: `user${i}@dummy.com`,
      FirstName: `User${i}`,
      LastName: `Last${i}`,
      Number: `98201717${10 + i}`,
      LastModifiedDate: new Date().toISOString(),
    };

    insertPromises.push(
      docClient.send(new PutCommand({ TableName: TABLE_NAME, Item: item })),
    );
  }

  await Promise.all(insertPromises);
  console.log("All records inserted");
}

insertDummyData().catch(console.error);
