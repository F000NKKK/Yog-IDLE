import type { ReactNode } from "react";
import { KeyHints, Toolbar, ToolbarGroup, ToolbarLabel, usePropertyContext, useT, type KeyHint, type PropertyDescriptor } from "substrate-platform-ui";
import type { DefFile } from "./defModel";
import "../designers.css";

/** What every `.ydef` kind's designer is given. */
export interface DefProps {
  path: string;
  file: DefFile;
  /** Changes the file: `edit` gets a copy to change; the text is patched, comments kept. */
  update: (edit: (draft: DefFile) => void) => void;
  readOnly: boolean;
  /** The kind's name, as the registry of designers has it. */
  kindLabel: string;
}

/**
 * A definition designer's frame, as every Yog designer: a compact toolbar
 * (the kind first, then the designer's own tools), the content drawn as
 * the game shows it filling the rest, and Properties showing `properties`
 * (what's picked, or the definition).
 */
export function DefLayout({
  path,
  kindLabel,
  tools,
  children,
  properties,
  objectName,
  objectType,
  objectKey,
  hints,
}: {
  path: string;
  kindLabel: string;
  tools?: ReactNode;
  children: ReactNode;
  properties: PropertyDescriptor[];
  objectName: string;
  objectType?: string;
  objectKey?: string;
  hints?: KeyHint[];
}) {
  const t = useT();
  usePropertyContext(path, {
    order: "declared",
    objectName,
    objectType: objectType ?? t(kindLabel),
    objectKey: objectKey ?? path,
    properties,
    footer: hints ? <KeyHints hints={hints} /> : undefined,
  });
  return (
    <div className="designer">
      <Toolbar>
        <ToolbarGroup>
          <ToolbarLabel>{t(kindLabel)}</ToolbarLabel>
        </ToolbarGroup>
        {tools}
      </Toolbar>
      <div className="designer-body">{children}</div>
    </div>
  );
}
