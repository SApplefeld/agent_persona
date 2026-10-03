// The type contract .claude-plugin/plugin.json names under "types": the
// values this plugin holds in $.state, which the host keeps across a reload
// of the plugin's code and never persists. memqLaunchDir is the launch
// directory kitMemq runs memq from, written once by the first session.start
// that captures one.
declare module "claude-code" {
  interface PluginState {
    "personas": { memqLaunchDir: string };
  }
}
