// src/s3.ts

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

import fs from "node:fs";
import { pipeline } from "node:stream/promises";

const s3 = new S3Client({
  region: process.env.AWS_REGION!,
});

export async function downloadLibreChatFile(
  objectKey: string,
  destination: string,
) {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: process.env.LIBRECHAT_S3_BUCKET!,
      Key: objectKey,
    }),
  );

  if (!response.Body) {
    throw new Error("S3 object has no body");
  }

  await pipeline(
    response.Body as NodeJS.ReadableStream,
    fs.createWriteStream(destination),
  );

  return destination;
}
