// src/s3.ts

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

import fs from "node:fs";
import { pipeline } from "node:stream/promises";

const s3 = new S3Client({
  region: process.env.AWS_REGION!,
});

export async function downloadFromUrl(url: string, destination: string) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to download image ${response.status}: ${await response.text()}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  await fs.writeFile(destination, buffer);
}
