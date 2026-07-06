{ pkgs, lib, config, inputs, ... }:

{
  # Load a local, git-ignored .env file into the dev shell so secrets like
  # GITHUB_PERSONAL_ACCESS_TOKEN are available to tooling (e.g. the GitHub MCP
  # server configured in .mcp.json). See .env.example for the expected vars.
  dotenv.enable = true;

  languages = {
    nix.enable = true;
    javascript.bun.enable = true;
  };
  packages = with pkgs; [ git gh claude-code curl bun ];
}
