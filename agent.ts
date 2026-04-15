import * as readline from "node:readline/promises";
import { loadState, runAgent, DEFAULT_MODEL } from "./core";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function main() {
  const state = loadState();

  const args = process.argv.slice(2);
  const modelIdx = args.indexOf("--model");
  const modelStr = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
  const promptArgs = args.filter((_, i) => i !== modelIdx && i !== modelIdx + 1);
  const prompt = promptArgs.join(" ") || "Check the repo and summarize 'notes.pdf'.";

  console.log(`Using model: ${modelStr ?? process.env.MODEL ?? DEFAULT_MODEL}`);

  const approve = async (msg: string) => {
    const ok = await rl.question(`⚠️  ${msg}: `);
    return ok.toLowerCase() === "y";
  };

  try {
    const response = await runAgent(prompt, state, approve, undefined, modelStr);
    console.log("\nAgent response:", response);
  } finally {
    rl.close();
  }
}

main();
