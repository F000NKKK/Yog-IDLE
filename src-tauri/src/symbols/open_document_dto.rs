//! An open editor's buffer, as the front end sends it.

use serde::Deserialize;
use substrate_search_domain::project::OpenDocument;

/// An open editor's buffer, searched instead of the file on disk.
#[derive(Debug, Clone, Deserialize)]
pub struct OpenDocumentDto {
    path: String,
    text: String,
}

impl From<OpenDocumentDto> for OpenDocument {
    fn from(document: OpenDocumentDto) -> Self {
        Self {
            path: document.path,
            text: document.text,
        }
    }
}
