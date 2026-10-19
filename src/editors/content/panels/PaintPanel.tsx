import { Button, Spacer } from "substrate-platform-ui";
import { PaintTools } from "../../../content/paint/PaintTools";
import type { ContentView } from "../contentView";

/** The outliner's Paint pane: the paint tools, and New Texture. */
export function PaintPanel({ view }: { view: ContentView }) {
  const { t, paint, setPaint } = view.m;
  return (
    <>
      <div className="content-pane-header">
        <span>{t("Paint")}</span>
        <Spacer />
        <Button variant="ghost" onClick={() => void view.pt.newTexture()} title={t("A blank texture for the slot being painted")}>
          {t("New Texture…")}
        </Button>
      </div>
      <PaintTools paint={paint} onChange={setPaint} disabled={view.props.readOnly} />
    </>
  );
}
