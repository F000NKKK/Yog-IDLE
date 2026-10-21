import { useEffect, useState } from "react";
import { serveMethod } from "../data/yogIds.generated";
import { cli } from "../cli";
import { JsonEditor, useT, type EditorProps } from "substrate-platform-ui";

/**
 * A `.ydata` file — binary Yog Data, what `yog build` compiles a format to
 * (`.yog-build/generated/`) — shown as Yog Data text, read only.
 */
export function YdataViewer({ path }: EditorProps) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    cli<string>(serveMethod.YDATA_TEXT, { path })
      .then((s) => {
        setText(s);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [path]);
  if (error) return <div style={{ padding: 8 }}>{t("Can't read {path} as Yog Data: {error}", { path, error })}</div>;
  if (text === null) return null;
  return <JsonEditor path={path} content={text} onChange={() => {}} readOnly />;
}
