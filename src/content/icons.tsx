import { createIcon, registerIcons } from "substrate-platform-ui";

// Icons of `.yblock` / `.yitem` files (Project Explorer, tabs, New Item) and of
// their editor's paint tools.

/** An isometric cube. */
const IconYogBlock = createIcon(
  <>
    <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5 12 12l8-4.5" />
    <path d="M12 12v9" />
  </>
);

/** A gem — an item. */
const IconYogItem = createIcon(
  <>
    <path d="M7 4h10l4 5-9 11L3 9z" />
    <path d="M3 9h18" />
    <path d="M10 4 8.5 9 12 20l3.5-11L14 4" />
  </>
);

// The texture paint tools.

const IconPaintPencil = createIcon(
  <>
    <path d="M4 20l1-4L16 5l3 3L8 19z" />
    <path d="M14 7l3 3" />
  </>
);
const IconPaintEraser = createIcon(
  <>
    <path d="M8 20h12" />
    <path d="M4.5 14.5 14 5l5 5-8.5 8.5a2 2 0 0 1-2.8 0l-3.2-3.2a.7.7 0 0 1 0-.8z" />
    <path d="M9 10l5 5" />
  </>
);
const IconPaintFill = createIcon(
  <>
    <path d="M5 11l6-6 7 7-6 6a1.4 1.4 0 0 1-2 0l-5-5a1.4 1.4 0 0 1 0-2z" />
    <path d="M5 11h13" />
    <path d="M20 15s1.5 2 1.5 3a1.5 1.5 0 0 1-3 0c0-1 1.5-3 1.5-3z" />
  </>
);
const IconPaintPicker = createIcon(
  <>
    <path d="M14 6l4 4" />
    <path d="M16 4.5a2 2 0 0 1 3 3L17.5 9 15 6.5z" />
    <path d="M15.5 8.5 7 17l-3 1 1-3 8.5-8.5" />
  </>
);
const IconPaintLine = createIcon(<path d="M5 19 19 5" />);
const IconPaintRect = createIcon(<rect x="5" y="6" width="14" height="12" rx="1" />);
const IconPaintMirror = createIcon(
  <>
    <path d="M12 3v18" strokeDasharray="2 2" />
    <path d="M9 7 4 12l5 5z" />
    <path d="M15 7l5 5-5 5z" />
  </>
);

registerIcons({
  yogBlock: IconYogBlock,
  yogItem: IconYogItem,
  paintPencil: IconPaintPencil,
  paintEraser: IconPaintEraser,
  paintFill: IconPaintFill,
  paintPicker: IconPaintPicker,
  paintLine: IconPaintLine,
  paintRect: IconPaintRect,
  paintMirror: IconPaintMirror,
});
