const { createClient } = require("@deepgram/sdk");
const tus = require('tus-js-client')
const dotenv = require("dotenv");
dotenv.config();
const logger = require("../src/logger.js")("debrief");

const { destructureArgs } = require("../helpers");
const { storeUserMemory } = require("../src/remember");

const DEEPGRAM_CLIENT = createClient(process.env.DEEPGRAM_API_KEY);

async function handleCapabilityMethod(method, args) {
  const [arg1, arg2, arg3, arg4, arg5, arg6] = destructureArgs(args);
  if (method === "transcribeRemoteAudio") {
    return transcribeRemoteAudio(arg1, arg2, arg3, arg4, arg5, arg6);
  } else {
    throw new Error(
      `Method ${method} not supported by Debrief capability.`,
    );
  }
}

/**
 * Generates an image from the given text using the Stable Diffusion API.
 * @param {string} url - The URL to fetch audio from.
 * @param {string} fileName - Name of the audio file.
 * @param {string} contentType - Media type of the audio file.
 * @param {string} userName
 * @param {string} conversationId
 * @param {string} resourceId
 * @returns {Promise<string>} - A promise that resolves to a JSON string representing the response data.
 * @throws {Error} - If an error occurs during the DeepGram API request.
 */
async function transcribeRemoteAudio(url, fileName, contentType, userName, conversationId, resourceId) {
  const file = await fetch(url).then(res => res.arrayBuffer())
  const buffer = Buffer.from(file);
  await uploadFile(buffer, fileName, contentType)
  const { result, error } = await DEEPGRAM_CLIENT.listen.prerecorded.transcribeFile(
    buffer,
    {
      model: "nova-2-meeting",
      detect_topics: true,
      diarize: true,
      paragraphs: true,
      smart_format: true,
      summarize: "v2",
      topics: true,
    },
  );
  if (error) throw new Error(error.message);
  await storeUserMemory(
    { username: userName, channel: conversationId, guild: "missive" },
    `Attachment ${fileName}: ${JSON.stringify(result.results)}`,
    "attachment",
    resourceId,
  );
  return `Successfully transcribe and upload: ${fileName}`;
}

async function uploadFile(fileBuffer, fileName, contentType) {
  return new Promise(async (resolve, reject) => {
    const upload = new tus.Upload(fileBuffer, {
      endpoint: `${process.env.SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${process.env.SUPABASE_API_KEY}`,
        'x-upsert': 'true',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: process.env.SUPABASE_STORAGE_BUCKET,
        objectName: fileName,
        contentType,
        cacheControl: 3600,
      },
      chunkSize: 6 * 1024 * 1024, // NOTE: it must be set to 6MB (for now) do not change it
      onError: function (error) {
        logger.error('Failed because: ' + error)
        reject(error)
      },
      onProgress: function (bytesUploaded, bytesTotal) {
        const percentage = ((bytesUploaded / bytesTotal) * 100).toFixed(2)
        logger.info(bytesUploaded, bytesTotal, percentage + '%')
      },
      onSuccess: resolve,
    })


    // Check if there are any previous uploads to continue.
    const previousUploads = await upload.findPreviousUploads();
    // Found previous uploads so we select the first one.
    if (previousUploads.length) {
      upload.resumeFromPreviousUpload(previousUploads[0]);
    }
    // Start the upload
    upload.start();
  })
}

module.exports = {
  handleCapabilityMethod,
};
