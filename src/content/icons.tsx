import { createIcon, registerIcons } from "substrate-platform-ui";

// Icons of `.yblock` / `.yitem` files (Project Explorer, tabs, New Item).

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

registerIcons({ yogBlock: IconYogBlock, yogItem: IconYogItem });
