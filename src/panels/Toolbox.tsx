import { useT } from "substrate-platform-ui";

export function Toolbox() {
    const t = useT();
    return (
        <div className="panel-placeholder">
            <p>{t("Widget kinds go here.")}</p>
        </div>
    );
}
