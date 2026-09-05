# OpenCode Panes Context

## Terms

**Owner**
The one person who uploads and manages artifacts in a Panes deployment. Other
people view shared artifacts; they do not have access to the owner's library.

**Project**
A named group of related artifacts, corresponding to the local project where
the owner creates them.

**Artifact**
A browser-ready creation, such as an HTML prototype, SVG, or built website.
An artifact belongs to one project and can have multiple uploaded versions.

**Upload**
An explicit private copy of selected local files to the owner's cloud library.
Uploading does not share the artifact or change local files.

**Version**
An immutable snapshot created by an upload. Editing local files does not change
an uploaded version. The owner can choose which uploaded version to share.

**Library**
The owner's private dashboard of uploaded artifacts, organized by project.

**Share Link**
A read-only link to one selected version of an artifact. Anyone holding the
link can view that version and access its uploaded files. Sharing has no expiry
by default; the owner may choose an expiry instead.

**Update Shared Version**
The owner's explicit choice to point an active share link at another uploaded
version. The link stays the same. New uploads never perform this action.

**Unpublish**
Stop access through the current share link without deleting the artifact or its
uploaded versions. Sharing again creates a new link.

**Expired**
A share link whose owner-selected expiry has passed. The artifact remains in
the private library, but the old share link no longer grants access.
