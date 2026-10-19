// The selection in Properties, the Edit menu and keys, the split view's XAML pane and the event handlers in code.

import type { DesignerDocument } from "./useDesignerDocument";
import type { DesignerEdits } from "./useDesignerEdits";
import type { DesignerPicture } from "./useDesignerPicture";
import type { ScreenDesignerProps } from "../ScreenDesigner";
import { useHandlerOpening } from "./hooks/useHandlerOpening";
import { usePropertyPublishing } from "./hooks/usePropertyPublishing";
import { useCommandRegistry } from "./hooks/useCommandRegistry";
import { useXamlLink } from "./hooks/useXamlLink";

/** The selection in Properties, the Edit menu and keys, the split view's XAML pane and the event handlers in code. */
export function useDesignerCommands(props: ScreenDesignerProps, designerDocument: DesignerDocument, designerPicture: DesignerPicture, designerEdits: DesignerEdits) {
  const handlerOpening = useHandlerOpening(props, designerDocument);
  const propertyPublishing = usePropertyPublishing(props, designerDocument, designerPicture, designerEdits, handlerOpening);
  const commandRegistry = useCommandRegistry(props, designerDocument, designerEdits);
  const xamlLink = useXamlLink(props, designerDocument, propertyPublishing, commandRegistry);
  const { openHandler, openHandlerRef } = handlerOpening;
  const { propertySet, publish, publishRef } = propertyPublishing;
  const { commands } = commandRegistry;
  const { selectionKey } = xamlLink;
  return { propertySet, publish, publishRef, commands, selectionKey, openHandler, openHandlerRef };
}

/** What `useDesignerCommands` gives the component. */
export type DesignerCommands = ReturnType<typeof useDesignerCommands>;
