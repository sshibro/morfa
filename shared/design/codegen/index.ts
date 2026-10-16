// Design → code (docs/design-tool.md §Design to code): CSS of a layer as dev mode shows it, React
// components and screens (or Vue single-file components), design tokens, and a ready Vite project. Pure: no DOM, no React.

export {cssForLayers, declarations, formatDeclarations, needsSvg, nodeToCss, type CssGroup, type CssOptions, type Decl} from './css';
export {componentName, memberName, nameWords, slugName, transliterate, valueName, NameRegistry} from './names';
export {componentModel, propType, type ComponentModel, type PropDef} from './model';
export {expandRoots, toReact, toVue, type AssetFile, type ComponentInfo, type Framework, type GeneratedFile, type PropInfo, type ReactOptions, type ReactResult, type Styling} from './react';
export {filesZip, projectFiles, projectZip, PROJECT_VERSIONS, TAILWIND_VERSIONS, type Project, type ProjectOptions} from './project';
export {vueProjectFiles, VUE_PROJECT_VERSIONS} from './vue-project';
export {collectTokens, tokensCss, tokensTs, type Token, type TokenTable} from './tokens';
export {declToTailwind, tailwindClasses} from './tailwind';
export {color as cssColor, px as cssPx} from './values';
