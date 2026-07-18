require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function run() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log("LIST OF MODELS:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("ERROR listing models:", err);
  }
}

run();
