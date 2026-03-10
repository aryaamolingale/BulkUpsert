# BulkUpsert

A AWS Lambda function that reads customer records from DynamoDB and bulk-upserts them into Salesforce Contacts using the Salesforce Bulk API v2. Failed records are routed to a Dead Letter Queue (DLQ), and successfully processed records are deleted from DynamoDB.

---

## Architecture Overview

```
DynamoDB Table
      │
      ▼
 Lambda Function
      │
      ├──► Salesforce Bulk API v2 (Upsert Contacts)
      │         │
      │         ├──► Success → Delete records from DynamoDB
      │         └──► Failed Records → SQS Dead Letter Queue
      │
      └──► AWS Secrets Manager (credentials & config)
```

---

## Files

| File | Description |
|------|-------------|
| `lambda.js` | Main Lambda function — scans DynamoDB, upserts to Salesforce, handles failures |
| `index.js` | Utility script to insert dummy data into DynamoDB for testing |

---

## Prerequisites

- Node.js 18+
- AWS account with:
  - A DynamoDB table
  - An SQS queue (for DLQ)
  - AWS Secrets Manager secret (see below)
  - Lambda execution role with permissions for DynamoDB, SQS, and Secrets Manager
- Salesforce org with:
  - A External Client App (OAuth2 `client_credentials` flow enabled)
  - A custom field `Platform_Shooper_Id__c` on the `Contact` object

---

## Secrets Manager Configuration

Create a secret named `bulkTransferSecredt` in AWS Secrets Manager with the following JSON structure:

```json
{
  "SF_CLIENT_ID": "your_salesforce_connected_app_client_id",
  "SF_CLIENT_SECRET": "your_salesforce_connected_app_client_secret",
  "SF_TOKEN_URL": "https://login.salesforce.com/services/oauth2/token",
  "SF_API_VERSION": "v60.0",
  "DYNAMO_TABLE_NAME": "CustomerInteractions",
  "DLQ_URL": "https://sqs.<region>.amazonaws.com/<account-id>/<queue-name>"
}
```


---

## DynamoDB Table Schema

**Table Name:** `CustomerInteractions` (configurable via Secrets Manager)

| Attribute | Type | Description |
|-----------|------|-------------|
| `externalId` | String (PK) | Unique identifier, maps to `Platform_Shooper_Id__c` in Salesforce |
| `FirstName` | String | Contact first name |
| `LastName` | String | Contact last name |
| `Email` | String | Contact email address |
| `Mobile` | String | Contact mobile phone number |
| `LastModifiedDate` | String | ISO timestamp of last modification |

---

## Lambda Function — How It Works

1. **Fetches secrets** from AWS Secrets Manager
2. **Scans all records** from DynamoDB (handles pagination automatically)
3. **Generates a CSV** payload from the records
4. **Authenticates** with Salesforce via OAuth2 `client_credentials`
5. **Creates a Bulk API v2 ingest job** for `Contact` upsert using `Platform_Shooper_Id__c` as the external ID
6. **Uploads the CSV** to the job
7. **Polls job status** (up to 10 attempts, 3s apart) until complete
8. **Handles failures:**
   - Failed Salesforce records are sent to the SQS DLQ
9. **Cleans up:** Deletes all records from DynamoDB if the job completed successfully

### Retry Logic

All HTTP requests use exponential backoff with up to **3 retries** on statuses `429`, `500`, `502`, `503`, `504`.

---

## Seed Script — Adding Test Data

The `index.js` script inserts 201 dummy records into the DynamoDB table.

### Usage

```bash
# Install dependencies
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb

# Set AWS credentials (if not using instance profile/role)
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=your_key
export AWS_SECRET_ACCESS_KEY=your_secret

# Run the seed script
node index.js
```

**Sample record inserted:**

```json
{
  "externalId": "ext2001",
  "Email": "user2001@dummy.com",
  "FirstName": "User2001",
  "LastName": "Last2001",
  "Number": "982017171011",
  "LastModifiedDate": "2025-01-01T00:00:00.000Z"
}
```


---

## IAM Permissions Required

The Lambda execution role needs the following permissions:

```json
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:Scan",
    "dynamodb:DeleteItem",
    "sqs:SendMessage",
    "secretsmanager:GetSecretValue"
  ],
  "Resource": "*"
}
```

---

## Environment

- **Runtime:** Node.js 18.x or later
- **Region:** Configured via DynamoDB/SQS client defaults (set `AWS_REGION` env var)
- **Trigger:** Manual invocation (no event source mapping required)
