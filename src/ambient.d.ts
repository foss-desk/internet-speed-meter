/**
 * Ambient type declarations for the GJS/GNOME Shell runtime environment.
 *
 * GJS uses Mozilla's SpiderMonkey engine which provides Web APIs like
 * TextDecoder natively, but these are not part of the ES2023 TypeScript
 * lib. We declare them here for type-safety without pulling in the DOM lib.
 */

import '@girs/gjs/ambient';
import '@girs/gnome-shell/ambient';

declare module 'resource:///org/gnome/shell/ui/popupMenu.js' {
    export class PopupMenu extends GObject.Object {
        addMenuItem(item: any, position?: number): void;
        removeAll(): void;
    }
    export class PopupBaseMenuItem extends GObject.Object {
        constructor(params?: any);
        add_child(actor: any): void;
    }
    export class PopupMenuItem extends PopupBaseMenuItem {
        constructor(text: string, params?: any);
        label: any;
        add_style_class_name(name: string): void;
    }
    export class PopupSeparatorMenuItem extends PopupBaseMenuItem {}
    export class PopupSubMenuMenuItem extends GObject.Object {
        constructor(text: string, wantIcon?: boolean);
        label: any;
        menu: PopupMenu;
    }
}


declare module 'resource:///org/gnome/shell/extensions/extension.js' {
    export class Extension {
        uuid: string;
        metadata: { name: string; [key: string]: any };
        path: string;
        getSettings(): import('@girs/gio-2.0').default.Settings;
    }
}

declare global {
    /** SpiderMonkey's built-in TextDecoder (WHATWG Encoding Standard) */
    class TextDecoder {
        constructor(
            label?: string,
            options?: { fatal?: boolean; ignoreBOM?: boolean },
        );
        decode(
            input?: Uint8Array | ArrayBuffer,
            options?: { stream?: boolean },
        ): string;
    }

    class TextEncoder {
        constructor();
        encode(input?: string): Uint8Array;
    }

    /**
     * GJS global error logger.
     * Logs to the GNOME Shell journal (journalctl).
     */
    function logError(error: Error, prefix?: string): void;
}
