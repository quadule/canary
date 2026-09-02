import { MultiSelect } from "@inkjs/ui";
import { Box, render, Text } from "ink";
import { type Cmd, runInherit } from "./run.js";

interface Step {
  commands: Cmd[];
  defaultSelected?: boolean;
  id: string;
  label: string;
}

// The setup steps, each just shelling out to the same published commands you can
// run by hand. The global installs (`cli-global` etc.) put `dailies`,
// `dailies-browser`, and `dailies-viewer` on PATH so day-to-day use drops the npx.
// Agent integration (skills / Claude Code plugin) is intentionally not a step:
// the wizard prints those commands after setup so each agent's own mechanism
// does the work.
function buildSteps(): Step[] {
  return [
    {
      id: "cli-global",
      label: "Install the `dailies` command globally (so you can skip npx)",
      commands: [{ file: "npm", args: ["i", "-g", "dailies-cli"] }],
      defaultSelected: true,
    },
    {
      id: "runtime",
      label: "Install the browser runtime (downloads Chromium)",
      commands: [{ file: "npx", args: ["-y", "dailies-cli", "install"] }],
      defaultSelected: true,
    },
    {
      id: "browser-global",
      label: "Also install `dailies-browser` globally (one-off automation)",
      commands: [{ file: "npm", args: ["i", "-g", "dailies-browser"] }],
      defaultSelected: false,
    },
    {
      id: "ui-global",
      label: "Also install the session viewer `dailies-viewer` globally",
      commands: [{ file: "npm", args: ["i", "-g", "dailies-ui"] }],
      defaultSelected: false,
    },
  ];
}

function SelectStep(props: {
  steps: Step[];
  onSubmit: (ids: string[]) => void;
}) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="yellow">
          dailies setup
        </Text>
        <Text dimColor>Browser automation + recorded QA sessions.</Text>
      </Box>
      <Text>Choose what to set up (space toggles, enter confirms):</Text>
      <MultiSelect
        defaultValue={props.steps
          .filter((s) => s.defaultSelected)
          .map((s) => s.id)}
        onSubmit={props.onSubmit}
        options={props.steps.map((s) => ({ label: s.label, value: s.id }))}
      />
    </Box>
  );
}

function printManual(): void {
  process.stdout.write(
    [
      "",
      "dailies setup — run these:",
      "",
      "  npm i -g dailies-cli            # adds the `dailies` command",
      "  dailies install                     # browser runtime (Chromium)",
      "",
      "Optional:",
      "  npm i -g dailies-browser        # dailies-browser (one-off automation)",
      "  npm i -g dailies-ui             # dailies-viewer (session viewer)",
      "",
      "Then:",
      "  dailies session start --name checkout",
      "  dailies-viewer                      # browse recorded sessions",
      "",
      "Claude Code plugin:",
      "  /plugin marketplace add quadule/dailies",
      "  /plugin install dailies@dailies-marketplace",
      "",
    ].join("\n")
  );
}

async function runSelected(steps: Step[], selected: string[]): Promise<void> {
  // Once `dailies` is on PATH we use it directly instead of `npx` for the
  // runtime download, so the wizard demonstrates the same no-npx flow it sets up.
  const cliGlobal = selected.includes("cli-global");
  for (const step of steps) {
    if (!selected.includes(step.id)) {
      continue;
    }
    process.stdout.write(`\n▶ ${step.label}\n`);
    const commands =
      step.id === "runtime" && cliGlobal
        ? [{ file: "dailies", args: ["install"] }]
        : step.commands;
    let ok = true;
    for (const cmd of commands) {
      const code = await runInherit(cmd);
      if (code !== 0) {
        ok = false;
        break;
      }
    }
    process.stdout.write(
      ok ? "  ✓ done\n" : "  ✗ failed — you can re-run this step later\n"
    );
  }
  const viewer = selected.includes("ui-global")
    ? "dailies-viewer"
    : "npm i -g dailies-ui   # then: dailies-viewer";
  process.stdout.write(
    [
      "",
      "✓ Setup complete.",
      "",
      "  Record a session:  dailies session start --name checkout",
      `  Open the viewer:   ${viewer}`,
      "  Demos:             see examples/ in the repo",
      "",
      "Add the agent integration yourself (one-time):",
      "  Claude Code plugin:       /plugin marketplace add quadule/dailies",
      "                            /plugin install dailies@dailies-marketplace",
      "",
      "",
    ].join("\n")
  );
}

async function main(): Promise<void> {
  const steps = buildSteps();
  // Ink needs a real terminal; in pipes/CI just print the commands.
  if (!process.stdin.isTTY) {
    printManual();
    return;
  }

  let selected: string[] = [];
  let dismiss: () => void = () => process.exit(0);
  const app = render(
    <SelectStep
      onSubmit={(ids) => {
        selected = ids;
        dismiss();
      }}
      steps={steps}
    />
  );
  dismiss = () => app.unmount();
  await app.waitUntilExit();

  if (selected.length === 0) {
    process.stdout.write("Nothing selected.\n");
    return;
  }
  await runSelected(steps, selected);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `create-dailies: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
});
