import { registerTranslations, RU } from "substrate-platform-ui";

/** Yog's tools and components (Tools > Yog Installer, Options > Environment) in Russian. */
registerTranslations(RU, {
  "Check Components...": "Проверить компоненты...",
  "Yog Installer...": "Yog Installer...",
  "Yog needs components that aren't installed: {names}. Tools > Yog Installer... sets them up.": "Для Yog нужны неустановленные компоненты: {names}. Их можно установить в меню \"Сервис > Yog Installer...\".",
  "Yog Mod Loader SDK": "Пакет SDK Yog Mod Loader",
  "… moves the color into resources/Colors.yres and refers to it.": "… переносит цвет в resources/Colors.yres и ссылается на него.",
  // Environment window
  Failed: "Ошибка",
  Install: "Установить",
  Update: "Обновить",
  "Everything Yog needs to build and run mods is installed.": "Все, что нужно Yog для сборки и запуска модов, установлено.",
  JDKs: "JDK",
  // Components (names and descriptions come from the backend in English)
  "Yog CLI": "Yog CLI",
  "yog build / run / publish — the Yog mod build tool (crates.io: yog-cli).": "yog build / run / publish — средство сборки модов Yog (crates.io: yog-cli).",
  "Rust (rustup)": "Rust (rustup)",
  "rustup, cargo and rustc — installs into ~/.cargo, no administrator rights needed.": "rustup, cargo и rustc — устанавливаются в ~/.cargo, права администратора не нужны.",
  "The Rust version the yog crates are built with — mods must use the same one.": "Версия Rust, которой собраны крейты yog, — моды должны использовать ту же.",
  "Platform targets": "Целевые платформы",
  "The Rust targets a .yog bundles natives for (Linux, Windows, macOS).": "Цели Rust, для которых .yog содержит нативные библиотеки (Linux, Windows, macOS).",
  "Links the Linux, Windows and macOS natives from one machine (uses zig).": "Компонует нативные библиотеки для Linux, Windows и macOS на одной машине (использует zig).",
  "The cross-linker cargo-zigbuild drives — installed into Yog IDLE's tools folder.": "Кросс-компоновщик, которым управляет cargo-zigbuild, — устанавливается в папку инструментов Yog IDLE.",
  "Fetches and updates the Yog Mod Loader checkout.": "Получает и обновляет копию Yog Mod Loader.",
  "Yog Mod Loader": "Yog Mod Loader",
  "The loader's Gradle dev instances (Fabric, NeoForge, Forge) run targets launch — Gradle downloads Minecraft on the first run.":
    "Отладочные экземпляры Gradle загрузчика (Fabric, NeoForge, Forge), которые запускают цели, — Gradle скачивает Minecraft при первом запуске.",
  // Options > Environment
  Java: "Java",
  "Local yog-api crate": "Локальный крейт yog-api",
  "Builds every mod against this yog-api (YOG_API_PATH) instead of crates.io — needed for hot reload of a locally built loader.":
    "Собирает все моды с этим yog-api (YOG_API_PATH) вместо crates.io — нужно для горячей перезагрузки с локально собранным загрузчиком.",
  "Build for this platform only ({platform}) — faster, but the .yog won't run elsewhere": "Собирать только для этой платформы ({platform}) — быстрее, но .yog не запустится на других",
  "Build for this platform only ({platform})": "Собирать только для этой платформы ({platform})",
});
