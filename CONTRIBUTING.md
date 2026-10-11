# Contributing to UFriend

[English](CONTRIBUTING.md) | [繁體中文](CONTRIBUTING.zh-TW.md)

Use [GitHub Issues](https://github.com/breeze0305/UFriend/issues) for reproducible bugs and feature requests. For vulnerabilities, follow [SECURITY.md](SECURITY.md).

## Report a problem

Include the UFriend version, Windows version, local or cloud processing source, steps to reproduce, expected behavior, and the actual result. Prefer a small synthetic EML, image, or recording over personal data. Review screenshots and logs before sharing them; remove account details, API keys, OAuth files, message content, and private paths.

## Propose a change

Discuss larger changes in an issue before implementing them. Keep changes focused, explain the resulting behavior, and update the relevant documentation. Contributions to the project's own code are provided under the [MIT License](LICENSE); retain the licenses and attribution of any third-party material you add.

Maintain separate English (`NAME.md`) and Traditional Chinese (`NAME.zh-TW.md`) versions of every project explanation. Update both versions together, keep their commands, facts, and limitations consistent, add language links, and list new documentation in both `docs/README.md` and `docs/README.zh-TW.md`. Preserve upstream license texts and hash-pinned runtime metadata byte for byte; provide a separate translation and link it from the documentation indexes instead of editing a pinned original.

1. Follow the [Windows setup guide](docs/guides/INSTALL_BUILD.md). Use `npm ci` to preserve the locked dependency versions.
2. Use an isolated workspace through `UFRIEND_DATA_DIR`; do not develop against your only copy of personal workspace data.
3. Run `npm run check` and tests appropriate to the change. Run `npm test` before submitting, and report any skipped media checks. UI or native changes may also require the smoke tests described in the guide.
4. Describe the problem, behavior change, validation, and remaining limitations in the pull request. Include English and Traditional Chinese UI changes where applicable.

Do not include credentials, OAuth downloads, personal mail, recordings, model weights, dependency folders, release packages, or test output. Keep `app/config/google-oauth.json` as the empty template. The PC model services are separate projects; their changes belong in their own repositories.

Build and packaging details, including FFmpeg prerequisites, are in the [installation guide](docs/guides/INSTALL_BUILD.md). `npm run package:portable` builds the single-file EXE with the pinned electron-builder toolchain; it does not publish it. Changes to the portable launcher or media installer should be checked for restart behavior, data persistence, and failures that preserve existing files. A successful package build is not a substitute for workflow tests.
