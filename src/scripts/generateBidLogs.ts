import fs from 'fs';
import { IBidLogs } from '../models/logs.model';

const errorScenarios = {
  opensea: [
    { title: "FETCH OPENSEA LISTINGS ERROR", message: "Failed to fetch listings: Rate limit exceeded" },
    { title: "BUILD ITEM OFFER ERROR", message: "Error building OpenSea item offer: {tokenId}" },
    { title: "INSUFFICIENT WETH BALANCE", message: "Wallet balance {balance} WETH is less than required {required} WETH" },
    { title: "SUBMIT OFFER TO OPENSEA ERROR", message: "Failed to submit offer: Invalid parameters" },
    { title: "BUILD OFFER ERROR", message: "Error constructing offer payload" },
    { title: "CANCEL ORDER ERROR", message: "Failed to cancel existing order: {orderId}" },
    { title: "SIGN CANCEL ORDER ERROR", message: "Failed to sign cancellation request" },
    { title: "POST ITEM OFFER ERROR", message: "API request failed with status 429" },
    { title: "FETCH OPENSEA OFFERS ERROR", message: "Unable to retrieve current offers" }
  ],
  blur: [
    { title: "INSUFFICIENT BETH BALANCE", message: "Wallet balance {balance} BETH is less than required {required} BETH" },
    { title: "FORMAT BID ERROR", message: "Invalid bid parameters for collection {collection}" },
    { title: "SUBMIT BID ERROR", message: "Failed to submit bid to Blur API" },
    { title: "GET ACCESS TOKEN ERROR", message: "Authentication failed: Invalid credentials" }
  ],
  magiceden: [
    { title: "MAXIMUM BID PRICE EXCEEDED", message: "magiceden counter offer {price} WETH for {collection} {tokenId} exceeds max bid price {maxPrice} WETH ON MAGICEDEN.Skipping ..." },
    { title: "API REQUEST FAILED", message: "MagicEden API request failed with status {status}" },
    { title: "SIGNATURE VERIFICATION FAILED", message: "Invalid signature for collection: {collection}" },
    { title: "INSUFFICIENT FUNDS", message: "Not enough funds to place bid of {price} WETH" }
  ]
};

const collections = [
  "doodles", "azuki", "boredapeyachtclub", "moonbirds", "pudgypenguins",
  "cryptopunks", "clonex", "coolcats", "worldofwomen", "deadfellaz"
];

function generateRandomTokenId(): string {
  return Math.floor(Math.random() * 10000).toString().padStart(4, '0');
}

function generateRandomPrice(): string {
  return (Math.random() * 100).toFixed(3);
}

function generateRandomDate(start: Date, end: Date): Date {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function replacePlaceholders(message: string, collection: string): string {
  return message
    .replace('{tokenId}', generateRandomTokenId())
    .replace('{collection}', collection)
    .replace('{price}', generateRandomPrice())
    .replace('{maxPrice}', generateRandomPrice())
    .replace('{balance}', generateRandomPrice())
    .replace('{required}', generateRandomPrice())
    .replace('{status}', String(Math.floor(Math.random() * 3 + 400)))
    .replace('{orderId}', Math.random().toString(36).substring(7));
}

function generateBidLogs(count: number): IBidLogs[] {
  const logs: IBidLogs[] = [];

  for (let i = 0; i < count; i++) {
    const marketplace = ['opensea', 'blur', 'magiceden'][Math.floor(Math.random() * 3)] as 'opensea' | 'blur' | 'magiceden';
    const scenarios = errorScenarios[marketplace];
    const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
    const collection = collections[Math.floor(Math.random() * collections.length)];
    const type = Math.random() > 0.3 ? 'error' : (Math.random() > 0.5 ? 'warning' : 'skipped');

    logs.push({
      taskId: `67a3ba245a05dc79069c8ea1`,
      title: scenario.title,
      message: replacePlaceholders(scenario.message, collection),
      type,
      marketplace,
    });
  }

  return logs;
}

function writeBidLogsToFile(count: number, filename: string): void {
  const logs = generateBidLogs(count);
  fs.writeFileSync(filename, JSON.stringify(logs, null, 2));
  console.log(`Generated ${count} bid logs and saved to ${filename}`);
}

// Generate 500 bid logs and save to file
writeBidLogsToFile(500, 'bidLogs.json'); 