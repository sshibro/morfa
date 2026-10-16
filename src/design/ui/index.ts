// The UI kit of "Morfa" (docs/design-tool.md §Design language). Every component renders
// under a `.dz` scope (DesignRoot or DzScope) and is styled by src/design/styles; nothing here
// uses src/ui or the app's own brand.

export {Button, IconButton, type ButtonProps, type ButtonVariant, type ControlSize, type IconButtonProps} from './Button';
export {TextInput, type TextInputProps} from './TextInput';
export {TextArea, type TextAreaProps} from './TextArea';
export {NumberField, type NumberFieldProps, type NumberChangeSource} from './NumberField';
export {evaluateNumberInput, formatNumber, settleNumber} from './number-expression';
export {Select, type SelectEntry, type SelectOption, type SelectProps} from './Select';
export {Menu, useContextMenu, useMenuTrigger, type MenuAnchor, type MenuCloseReason, type MenuProps} from './Menu';
export {tidySeparators, type MenuAction, type MenuItem, type MenuSubmenu} from './menu-model';
export {Popover, type PopoverProps} from './Popover';
export {Tooltip, TooltipLayer, hideTooltip, showTooltip, useTooltip, type TooltipContent} from './Tooltip';
export {SegmentedControl, TabPanel, Tabs, tabId, tabPanelId, type SegmentOption, type TabItem} from './Tabs';
export {Checkbox, Toggle} from './Toggle';
export {Slider, type SliderProps} from './Slider';
export {ColorSwatch, cssColor, type ColorSwatchProps} from './ColorSwatch';
export {Dialog, type DialogProps} from './Dialog';
export {ToastHost, useToast, type ShowToast, type ToastOptions} from './Toast';
export {PanelSection, type PanelSectionProps} from './PanelSection';
export {PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, ResizablePanel, type ResizablePanelProps} from './ResizablePanel';
export {Kbd, Spinner} from './Spinner';
export {EmptyState, ProgressBar} from './ProgressBar';
export {DzScope, LayerContext, Portal, useLayer} from './layer';
export {formatShortcut, isMacPlatform, isTypingTarget, matchesShortcut, parseShortcut} from './shortcuts';
export {THEME_LABELS, setThemePreference, useResolvedTheme, useThemePreference, type Theme, type ThemePreference} from './theme';
export {placeFloating, type Placement} from './position';
export * from './icons';
