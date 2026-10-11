# Gmail Setup Guide

[English](GMAIL_SETUP_GUIDE.md) | [繁體中文](GMAIL_SETUP_GUIDE.zh-TW.md)

UFriend's public source code and public releases do not include a shared Google OAuth client. To connect Gmail, create your own **Desktop app OAuth client**, import its configuration into UFriend, and then authorize your Google account. Without Gmail, you can still import EML files and manage local drafts.

The Client ID identifies the application; authorization tokens for each Gmail account are generated separately after sign-in. UFriend opens sign-in in the system browser and does not receive your Google password. Google Console labels and account policies may change; refer to the linked official documentation and the screens you see.

## Prerequisites

- A Google account that can manage a Google Cloud project and use Gmail.
- UFriend running as described in the [installation guide](INSTALL_BUILD.md).
- A location for the downloaded OAuth file, either outside the repository or in the Git-ignored `local/credentials/` directory. Do not commit downloaded credentials, tokens, or API keys, or paste them into public issues.

This flow uses an **OAuth Client ID**, not an API key, service account, or Web application client. See [Google credential types](https://developers.google.com/workspace/guides/create-credentials).

## 1. Create a project and enable the Gmail API

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project you manage, such as UFriend.
2. Confirm that the project selector at the top shows the correct project.
3. Open **APIs & Services → Library**, search for **Gmail API**, and enable it.
4. Confirm that Gmail API appears in the list of enabled APIs.

Use the same project for the OAuth settings that follow. See [Create a project](https://developers.google.com/workspace/guides/create-project) and [Enable Workspace APIs](https://developers.google.com/workspace/guides/enable-apis).

## 2. Configure the consent screen and users

Open **Google Auth Platform** and complete the application name, support email, and contact information under **Branding**. For personal testing, choose an External audience appropriate for personal accounts, keep the project in **Testing**, and add the account you will actually use under **Audience → Test users**. Available settings for organization accounts depend on organization policy.

Do not treat an example test email address as a real user. The Google Cloud project's contact email and the Test users list are separate settings. See [Configure the OAuth consent screen](https://developers.google.com/workspace/guides/configure-oauth-consent).

## 3. Add the permission scope

Under **Data Access → Add or remove scopes**, add and save:

```text
https://www.googleapis.com/auth/gmail.modify
```

UFriend uses this scope to read and manage mail, handle drafts, and send messages. Google classifies it as a restricted scope. It does not allow permanent deletion that bypasses Trash. Granting only `gmail.readonly` cannot support the full mail-management feature set. See the [Gmail scope table](https://developers.google.com/workspace/gmail/api/auth/scopes).

## 4. Create a Desktop client and download its JSON

1. Open **Clients → Create Client**.
2. Set Application type to **Desktop app**.
3. Enter a recognizable name, such as UFriend Windows.
4. Create the client, then download and safely store the original JSON file.

Do not select Web application. UFriend starts its own temporary callback at `127.0.0.1`; you do not need to enter JavaScript origins used by web applications. See [Create a Desktop client](https://developers.google.com/workspace/guides/create-credentials#desktop-app) and the [Desktop OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app).

## 5. Import the configuration and sign in to UFriend

1. Open **Settings → Email accounts → Advanced settings (developers)**.
2. Choose **Import Google configuration** and select the downloaded Desktop app JSON. The application checks the format; you do not need to copy individual fields.
3. After importing, choose **Connect with Google**.
4. In the system browser, select an allowed account, check the application and requested Gmail permissions, and decide whether to authorize access.
5. Return to UFriend and check the account and synchronization status. **Sync preferences** lets you adjust the initial synchronization range and automatic synchronization interval.

If Google displays an unverified-application notice, confirm that the project is yours and that you are using an allowed test account. Organization policies can also prevent authorization. Do not bypass warnings for unfamiliar applications.

Importing saves only the local connection configuration. It does not change the blank template in the source code or share the configuration with other users. Clearing the local override returns a public build to its unconfigured state. If the first synchronization fails but the account is already connected, use **Sync** beside the account to retry and inspect the error; there is no need to repeatedly create OAuth clients.

## Data and permission boundaries

- Sign-in uses OAuth, PKCE, state, and a local callback. Gmail tokens are stored through Electron `safeStorage`.
- Mail, attachments, drafts, and settings are saved in the local workspace. Ordinary content is not stored in an encrypted database.
- Gmail synchronization and sending connect to Google. When mail analysis is enabled, the necessary text and fields are sent to the local or cloud model endpoint selected for that task. Gmail tokens are not sent to the model. See [Model sources and data flow](MODEL_SOURCES.md).
- Shutting down model services does not affect Gmail authorization. Authorizing Gmail does not automatically install models or configure cloud AI.
- If the result of a send operation is uncertain, check Gmail's Sent folder before deciding whether to retry. The application does not automatically resend the message.

## Developers: preconfigure your own build

Users of the ordinary public release should use the local import method above. If you maintain your own distribution, you can provide an external OAuth JSON file at packaging time. See the complete procedure in the [installation guide](INSTALL_BUILD.md#optional-google-sign-in-configuration).

Keep `app/config/google-oauth.json` as a blank template. The packager's `UFRIEND_GOOGLE_OAUTH_FILE` writes only the required Desktop client fields into the new package. These fields are distributed with that package, while user authorization tokens remain stored separately on each user's computer. Successful packaging or `gmailConfigured: true` does not mean Google has verified the application.

Before offering your OAuth client to others, check Google's audience settings, test-user restrictions, branding and restricted-scope verification requirements, and the data flow of the actual deployment. Switching to Production does not complete verification. This guide does not claim that UFriend's public releases contain a verified shared OAuth client.

Official references: [Audience and authorization lifetime](https://support.google.com/cloud/answer/15549945?hl=en) · [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

## Frequently asked questions

| Situation | What to check |
| --- | --- |
| The account cannot access the application or is not listed as a test user | Check that the account used for sign-in is in Test users for the same project, and review organization restrictions. |
| The JSON import is rejected | Confirm that it is the Desktop app JSON downloaded from Google, not a Web client, service account, or manually rewritten file. |
| Authorization does not return to the application | Keep UFriend open; cancel and sign in again, retaining error details that contain no credentials. |
| Sign-in is requested again after a period of use | Check the project's Testing status, authorization lifetime, or revocation status, then reconnect as directed on screen. |
| The account exists but no mail appears | Check synchronization status, the number of days included in the initial sync, and inbox filters. Having no mail within the selected range can be normal. |
| Sign-in no longer works after clearing local settings | Public builds do not include an OAuth client. Import your own Desktop JSON again. |
| The send result is unclear | Check Gmail's Sent folder before resending; do not immediately retry. |

For more operations, see the [user guide](APP_README.md). Google API usage rules are defined in the [official quota documentation](https://developers.google.com/workspace/gmail/api/reference/quota).
