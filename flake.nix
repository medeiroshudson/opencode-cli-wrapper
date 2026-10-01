{
  description = "OpenAI-compatible HTTP API for the OpenCode CLI";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  inputs.opencode.follows = "nixpkgs";

  outputs = { self, nixpkgs, opencode }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          nodejs = pkgs.nodejs_24;
          opencodePackage = opencode.packages.${system}.opencode or
            (opencode.packages.${system}.default or opencode.legacyPackages.${system}.opencode);
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "opencode-cli-wrapper";
            version = "0.1.0";
            src = self;

            inherit nodejs;
            npmDepsHash = "sha256-bWoxF2TU41jhVcGexox16Lwkb2X3YmaAIX/sDfhwdKs=";
            nativeBuildInputs = [ pkgs.makeWrapper ];

            installPhase = ''
              runHook preInstall
              npm prune --omit=dev --ignore-scripts
              mkdir -p "$out/lib/opencode-cli-wrapper" "$out/bin"
              cp -r dist node_modules package.json "$out/lib/opencode-cli-wrapper/"
              makeWrapper ${nodejs}/bin/node "$out/bin/opencode-cli-wrapper" \
                --add-flags "$out/lib/opencode-cli-wrapper/dist/server.js" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ opencodePackage ]}
              runHook postInstall
            '';

            meta = {
              description = "OpenAI-compatible HTTP API that proxies the OpenCode CLI";
              homepage = "https://github.com/medeiroshudson/opencode-cli-wrapper";
              license = pkgs.lib.licenses.mit;
              mainProgram = "opencode-cli-wrapper";
              platforms = systems;
            };
          };
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          meta = self.packages.${system}.default.meta;
          program = "${self.packages.${system}.default}/bin/opencode-cli-wrapper";
        };
      });
    };
}
