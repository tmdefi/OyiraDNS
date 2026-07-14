import { decideDomainAgentNextAction, decideDomainAgentNextActionWithGemini, DOMAIN_PURCHASE_AGENT_PROMPT } from "../agent.js";
import { loadConfig } from "../config.js";
import { GeminiClient } from "../gemini.js";

interface CliOptions {
  message?: string;
  showPrompt?: boolean;
  useGemini?: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const next = args[index + 1];

    switch (token) {
      case "--message":
        options.message = next;
        index += 1;
        break;
      case "--prompt":
        options.showPrompt = true;
        break;
      case "--gemini":
        options.useGemini = true;
        break;
      default:
        if (!token.startsWith("--")) {
          options.message = [token, ...args.slice(index + 1)].join(" ");
          return options;
        }
        break;
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.showPrompt) {
  console.log(DOMAIN_PURCHASE_AGENT_PROMPT);
} else {
  const message = options.message?.trim();

  if (!message) {
    throw new Error('Missing customer message. Use --message "check example.com" or pass the message directly.');
  }

  if (options.useGemini) {
    const config = loadConfig();
    const gemini = new GeminiClient(config.gemini);

    if (!gemini.enabled) {
      throw new Error("Missing GEMINI_API_KEY or GOOGLE_API_KEY for --gemini.");
    }

    console.log(JSON.stringify(await decideDomainAgentNextActionWithGemini(message, gemini), null, 2));
  } else {
    console.log(JSON.stringify(decideDomainAgentNextAction(message), null, 2));
  }
}
