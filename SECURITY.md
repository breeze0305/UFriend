# Security

## Reporting a vulnerability

Do not post exploit details, credentials, personal mail, or private workspace files in a public issue.

Use the repository's **Security → Report a vulnerability** option if private reporting is enabled. If that option is unavailable, open a minimal issue requesting a private security contact, without disclosing the vulnerability. Wait for a private channel before sending details. The project does not currently publish a response-time commitment.

A useful report includes the affected version, Windows version, the component or processing source involved, a description of the impact, and reproduction steps using synthetic data. Remove API keys, OAuth client files, tokens, account information, and unrelated files.

## Security boundaries

- Workspace content is stored as ordinary local files. Gmail credentials and API keys use Electron `safeStorage`; they are tied to the Windows user account and should not be assumed portable between accounts or computers.
- Gmail connects to Google, external mail images may contact their source hosts, and selected cloud AI tasks send input to the configured provider. Review the [data-flow guide](docs/guides/MODEL_SOURCES.md) before using sensitive material.
- Local model services are separate projects and are intended for loopback access on the same computer. UFriend does not install, update, start, or stop them.
- AI responses and mail suggestions require human review. Content validation is limited and does not guarantee semantic correctness or complete prompt-injection resistance.

Report issues against the latest available release where possible. Older releases do not have a separate published security-maintenance schedule. Keep backups before upgrading or testing a fix, and review [workspace recovery](docs/guides/APP_README.md#保存與恢復) before moving data.
