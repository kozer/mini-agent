# mini-agent

## Requirements

Install these before running the project:

- [Bun](https://bun.com)
- `git`
- `bubblewrap` (`bwrap`) for sandboxed command execution
- An editor set in `$EDITOR` if you want to use `/export`

Optional, depending on which model/provider you use:

- `OPENROUTER_API_KEY` for OpenRouter models
- `GITHUB_TOKEN` for GitHub Copilot models
- A local OpenAI-compatible server if using `lmstudio` or `llama-cli`

## Local Development

Install dependencies:

```bash
bun install
```

Run the interactive CLI:

```bash
bun run cli.tsx
```

Or:

```bash
bun run dev
```

## Global Install

Install this project as a global Bun CLI:

```bash
bun pm pack
bun install -g "$PWD/mini-agent-0.1.0.tgz"
```

Then run it as:

```bash
mage
```

## Notes

- `mage` currently launches the interactive UI
- Add Bun's global bin dir to your `PATH` if needed: `export PATH="$HOME/.cache/.bun/bin:$PATH"`
- `bwrap` sandboxing is Linux-focused; macOS would need a different sandbox strategy or fallback

This project was created using `bun init` in bun v1.3.9. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Inspiration

Inspired by:

- <https://ampcode.com/notes/how-to-build-an-agent>
- <https://www.mihaileric.com/The-Emperor-Has-No-Clothes/>
- Claude docs: <https://platform.claude.com/docs/en/home>
