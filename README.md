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

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run 
```

This project was created using `bun init` in bun v1.3.9. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Inspiration

Inspired by:

- <https://ampcode.com/notes/how-to-build-an-agent>
- <https://www.mihaileric.com/The-Emperor-Has-No-Clothes/>
- Claude docs: <https://platform.claude.com/docs/en/home>
