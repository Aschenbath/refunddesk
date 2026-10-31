import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
const toolkit = new PayPalAgentToolkit({
  clientId: "compatibility-check",
  clientSecret: "not-a-real-secret",
  configuration: {
    actions: {
      orders: { get: true },
      payments: { createRefund: true, getRefunds: true },
    },
    context: { sandbox: true },
  },
});
const tools = toolkit.getTools();
const shapes = Object.entries(tools).map(([name, tool]) => ({
  name,
  parameters: "parameters" in tool,
  inputSchema: "inputSchema" in tool,
}));
console.log(
  JSON.stringify(
    {
      compatibleWithAi7: shapes.every((tool) => tool.inputSchema),
      tools: shapes,
    },
    null,
    2,
  ),
);
