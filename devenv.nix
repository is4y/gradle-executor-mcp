{ pkgs, lib, config, inputs, ... }:

{
  languages = {
    nix.enable = true;
    javascript.bun.enable = true;
  };
  packages = with pkgs; [ git claude-code curl bun ];
}
