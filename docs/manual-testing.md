# Test Panes in a New Session

Use these prompts one at a time. The agent creates files and uploads; you choose
what to publish in the dashboard. Keep a short record of the artifact IDs, version
numbers, share links, expected results, and any failures. Do not record credentials.

## Before starting

The simplified plugin must be installed and the OpenCode process that loads it
must be restarted. Creating another conversation in the same running process does
not reload its plugin. If using OpenChamber, the OpenCode backend process needs the
new plugin and environment, not just a new chat tab.

The new plugin and the target backend must both use the simplified interface.
Building and testing the repository does not install the plugin globally or deploy
the backend; both are separate setup steps. See [installation and hosting](../README.md#install-the-opencode-plugin).

Choose one test target and keep it consistent:

| Target                                        | What it tests                                                                 | Important distinction                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local Worker, such as `http://127.0.0.1:8787` | The plugin, library, previews, and sharing behavior on your machine           | The server must be running. Loopback links cannot be shared with remote collaborators, and local owner bypass does not test Cloudflare Access login. |
| Your updated HTTPS deployment                 | The complete hosted experience, including owner login and collaborator access | Requires the new upload secret, migration `0011`, Access route coverage, and deployment first.                                                       |

The OpenCode process needs `OPENCODE_PANES_API_URL` and
`OPENCODE_PANES_UPLOAD_KEY`. Do not paste the key into chat. The upload key must
match the target Worker's `PANES_UPLOAD_KEY`. No installation, configuration,
deployment, or remote deletion is authorized merely by reading this guide.

## 1. Check the session

```text
I am testing the simplified OpenCode Panes plugin. Confirm that this session
has artifact_upload and artifact_dashboard. If either is missing, stop and
explain what installation or process restart is needed. Do not substitute the
old Prepare/Finalize/Sync tools or bypass the plugin with direct API uploads.

Use artifact_dashboard to return the configured dashboard URL. Do not print
credentials or change any configuration. Tell me whether the target is local
or hosted. Do not deploy, publish, or delete anything.

For the rest of this test, create a new, uniquely named folder under panes-tests/
inside this project. Use it only for disposable test artifacts, keep its path
consistent, and record the results of each test without credentials. Ask before
any installation, configuration change, or deletion.
```

**Pass:** Both tools are available and the dashboard link uses the intended
origin. The new tool is `artifact_upload`, not `artifact_sync`.

## 2. Create locally, without uploading

```text
In our new Panes test folder, create a browser-ready prototype named Trip planner.
Put it in a trip-planner/ subfolder with index.html, styles.css, app.js, and a
small SVG illustration. Use relative asset URLs and no external dependencies.
Include a button that adds a destination and a toggle that changes the view.
Show a visible marker reading "Version one".

Do not upload yet. Do not create Panes manifests, Drafts, or local v1/v2 folders.
Do not overwrite existing files. Tell me which files you created.
```

**Pass:** These are ordinary editable files. Refreshing the dashboard does not
show this new artifact. Local preview, if wanted, uses your usual browser/dev
tools; Panes does not provide a local preview server.

## 3. Upload privately and retry

```text
Use artifact_upload to upload our trip-planner/ folder, with index.html as the
entry and "Trip planner" as the title. Keep all upload metadata consistent in
later tests. Do not publish it. Return its artifact ID, version, and dashboard URL.

Then repeat the identical upload once without changing any file or metadata.
Check that it returns the same artifact ID and version, not a duplicate.
```

**Pass:** Approve the upload permission when requested. One artifact appears
under the correct project with **Private** status and one cloud version.

In the dashboard, click the card and check the illustration, styling, add button,
and toggle. Try search, the project navigation, and Private/Shared filters. Also
check a narrow browser window; Panes should remain light in dark-mode preferences.

## 4. Publish the first version

This step is yours in the dashboard:

1. Select version 1 and **No expiry**.
2. Click **Publish** and check the confirmation names the selected version and
   explains that its uploaded files will be accessible.
3. Confirm, click **Copy link**, and open the link in a separate/private browser
   session. For a hosted target, a collaborator can also try it on another device.
4. Keep that link for the following tests.

**Pass:** The share shows version 1, **No expiry**, and the working prototype.
It has no owner management controls. Use the share link, not your dashboard URL.

## 5. Upload a private second version

```text
I have published version 1 through the dashboard. Update the same local
trip-planner/ folder: change the visible marker to "Version two", change its
accent color, and add a packing checklist. Keep the existing interactions working.

Upload the same folder again with exactly the same title and other metadata.
Do not publish or update any share. Return the artifact ID and new version.
```

**Pass:** The artifact ID stays the same and version 2 appears. The old share
still shows **Version one** on a fresh load. The gallery distinguishes
**Latest v2 / Shared v1**. Selecting version 1 in the owner preview still shows
the old content.

Now select version 2, choose **No expiry**, click **Update shared version**, and
confirm. **Pass:** The original share URL now shows **Version two** on refresh;
its URL has not changed.

## 6. Set an expiry, unpublish, and share again

In the dashboard:

1. Choose **After 1 day**, update the shared version, and confirm. Record the
   displayed deadline. The active share URL should stay the same.
2. Unpublish and confirm. Open the old share URL in a new tab or refresh it.
3. Publish again with **No expiry**. Compare the new link with the old one.

**Pass:** A finite deadline is visible; unpublish makes fresh requests to the old
link fail; republishing creates a different link and does not revive the old one.

Changing to a finite duration starts that duration at the latest confirmation;
it does not preserve the previous deadline. Already-loaded pages or downloaded
copies cannot be erased by unpublishing.

Setting a deadline is not the same as observing expiry. To test natural expiry,
leave a separate disposable artifact shared for one day and revisit after the
displayed deadline. Do not change system clocks or edit server data to simulate
that manual check. Automated tests cover expiry without waiting a day.

## 7. Try a standalone SVG

```text
Create a self-contained SVG named route-map.svg in our test folder. Include
a simple illustrated route and labels. Upload that file alone to Panes with
the title "Route map". Record its SHA-256 before uploading so we can check local
preservation later. Do not publish it or change Trip planner.
```

**Pass:** A second, private artifact appears in the same project. Its card and
detail preview display the SVG without needing an HTML wrapper.

## 8. Try browser-built JavaScript

```text
Create another disposable prototype in our test folder, named Counter study.
Use index.html with an initially empty root element and a relative module
script app.js that renders the whole interface. Include working increment
and reset buttons. Use no external packages. Upload its folder privately.
```

**Pass:** The JavaScript-rendered interface appears in both the card thumbnail
and the detail preview. Buttons work in the detail preview; the card itself
opens the artifact rather than interacting with the thumbnail.

For a real React/framework check, ask OpenCode to build an existing disposable
frontend locally with relative asset URLs, then upload its browser output folder
with an HTML entry. Raw TSX is not a supported entry. Package installation, if
needed, is a separate local development action, not something Panes does.

## 9. Check a second project

Open another session in a genuinely different project, using the same configured
plugin and backend. Do not use another subfolder or another worktree of the same
Git remote as a substitute for a different project.

```text
Create a small, self-contained HTML color palette in a new disposable folder
inside this project. Upload it privately to Panes, titled "Palette study".
Do not change any other artifacts or projects.
```

**Pass:** A separate project appears in the library. Each project's navigation
shows only its artifacts; All artifacts shows both projects. A `projectName`
override changes the display name, not the project's identity. Copies with the
same normalized Git remote intentionally group together.

## 10. Check safe selection and rejection

```text
In a new subfolder of our disposable test folder, create an index.html with
the text "Safe selection" and a file named dummy.pem containing only the
literal text "NOT A REAL KEY". Do not read or copy any real credentials.

Upload the folder privately. Help me verify that index.html is included and
dummy.pem is excluded. Do not publish or bypass the plugin's exclusions.
```

**Pass:** The upload contains one file. You can inspect the file count in the
Publish confirmation and then **Cancel** without sharing anything.

Optional negative tests:

| Test                                                                             | Expected result                                                                   |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Ask to upload a raw `.tsx` entry without building it                             | Rejected with guidance to use HTML/SVG or build first                             |
| Put a symlink to another disposable fixture inside the selected folder           | Rejected; the link is not followed                                                |
| Use `../index.html` as the entry path                                            | Rejected as unsafe                                                                |
| Add a disposable 26 MiB `.bin` file beside a valid HTML entry and attempt upload | Rejected before creating an upload; no need to transfer a large file successfully |
| Deny a new upload permission when OpenCode asks                                  | No upload is sent; if permission is already remembered, this case is not tested   |

Only generate disposable fixtures for these tests. Do not modify real keys,
environment files, global plugin settings, or system clocks.

## 11. Delete a disposable cloud artifact

Choose **Route map**, not an existing artifact you care about. In its dashboard
detail, click **Delete artifact**, check the cloud-only confirmation, and confirm.

Then send:

```text
I deleted the Route map cloud artifact through the dashboard. Verify that our
local route-map.svg still exists and is unchanged. Do not upload it again or
delete any local files. Summarize all test results so far, separating passed,
failed, and not-yet-tested behavior. Include reproduction steps for any failure,
but no credentials.
```

**Pass:** The artifact disappears from the library, any link to it stops serving
new requests, and the original local SVG is unchanged. If it was never shared,
do not claim that deleting a shared artifact was tested.

## Hosted-only checks

These checks require the HTTPS Cloudflare deployment, not local owner bypass:

- Open the dashboard in a signed-out browser: it requires the owner's Access login.
- Open a share in a separate signed-out browser: it works without owner login.
- Verify the share shows only the selected version, not the private library or
  other versions.
- Optionally test a public HTTPS font/image or API in a disposable artifact.
  Ordinary browser CORS still applies; Panes does not proxy around it or supply
  credentials. Lack of an HTTP-origin approval prompt is intentional.

Do not run the local-only `test:acceptance` script against your hosted service.
Use this manual workflow for hosted testing and keep destructive actions limited
to the disposable artifacts you selected.
