/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import {NgCompiler} from '@angular/compiler-cli/src/ngtsc/core';
import {
  PotentialDirective,
  PotentialDirectiveModuleSpecifierResolver,
  PotentialImportMode,
  PotentialPipe,
  TemplateTypeChecker,
  TsCompletionEntryInfo,
} from '@angular/compiler-cli/src/ngtsc/typecheck/api';
import ts from 'typescript';
import {guessIndentationInSingleLine} from './format';
import * as path from 'path';
import {ClassDeclaration} from '@angular/compiler-cli/src/ngtsc/reflection';
import {Reference} from '@angular/compiler-cli/src/ngtsc/imports';

/**
 * Return the node that most tightly encompasses the specified `position`.
 * @param node The starting node to start the top-down search.
 * @param position The target position within the `node`.
 */
export function findTightestNode(node: ts.Node, position: number): ts.Node | undefined {
  if (node.getStart() <= position && position < node.getEnd()) {
    return node.forEachChild((c) => findTightestNode(c, position)) ?? node;
  }
  return undefined;
}

export interface FindOptions<T extends ts.Node> {
  filter: (node: ts.Node) => node is T;
}

/**
 * Finds TypeScript nodes descending from the provided root which match the given filter.
 */
export function findAllMatchingNodes<T extends ts.Node>(root: ts.Node, opts: FindOptions<T>): T[] {
  const matches: T[] = [];
  const explore = (currNode: ts.Node) => {
    if (opts.filter(currNode)) {
      matches.push(currNode);
    }
    currNode.forEachChild((descendent) => explore(descendent));
  };
  explore(root);
  return matches;
}

/**
 * Finds TypeScript nodes descending from the provided root which match the given filter.
 */
export function findFirstMatchingNode<T extends ts.Node>(
  root: ts.Node,
  opts: FindOptions<T>,
): T | null {
  let match: T | null = null;
  const explore = (currNode: ts.Node) => {
    if (match !== null) {
      return;
    }
    if (opts.filter(currNode)) {
      match = currNode;
      return;
    }
    currNode.forEachChild((descendent) => explore(descendent));
  };
  explore(root);
  return match;
}

export function getParentClassDeclaration(startNode: ts.Node): ts.ClassDeclaration | undefined {
  while (startNode) {
    if (ts.isClassDeclaration(startNode)) {
      return startNode;
    }
    startNode = startNode.parent;
  }
  return undefined;
}

/**
 * Returns a property assignment from the assignment value if the property name
 * matches the specified `key`, or `null` if there is no match.
 */
export function getPropertyAssignmentFromValue(
  value: ts.Node,
  key: string,
): ts.PropertyAssignment | null {
  const propAssignment = value.parent;
  if (
    !propAssignment ||
    !ts.isPropertyAssignment(propAssignment) ||
    propAssignment.name.getText() !== key
  ) {
    return null;
  }
  return propAssignment;
}

/**
 * Given a decorator property assignment, return the ClassDeclaration node that corresponds to the
 * directive class the property applies to.
 * If the property assignment is not on a class decorator, no declaration is returned.
 *
 * For example,
 *
 * @Component({
 *   template: '<div></div>'
 *   ^^^^^^^^^^^^^^^^^^^^^^^---- property assignment
 * })
 * class AppComponent {}
 *           ^---- class declaration node
 *
 * @param propAsgnNode property assignment
 */
export function getClassDeclFromDecoratorProp(
  propAsgnNode: ts.PropertyAssignment,
): ts.ClassDeclaration | undefined {
  if (!propAsgnNode.parent || !ts.isObjectLiteralExpression(propAsgnNode.parent)) {
    return;
  }
  const objLitExprNode = propAsgnNode.parent;
  if (!objLitExprNode.parent || !ts.isCallExpression(objLitExprNode.parent)) {
    return;
  }
  const callExprNode = objLitExprNode.parent;
  if (!callExprNode.parent || !ts.isDecorator(callExprNode.parent)) {
    return;
  }
  const decorator = callExprNode.parent;
  if (!decorator.parent || !ts.isClassDeclaration(decorator.parent)) {
    return;
  }
  const classDeclNode = decorator.parent;
  return classDeclNode;
}

/**
 * Collects all member methods, including those from base classes.
 */
export function collectMemberMethods(
  clazz: ts.ClassDeclaration,
  typeChecker: ts.TypeChecker,
): ts.MethodDeclaration[] {
  const members: ts.MethodDeclaration[] = [];
  const apparentProps = typeChecker.getTypeAtLocation(clazz).getApparentProperties();
  for (const prop of apparentProps) {
    if (prop.valueDeclaration && ts.isMethodDeclaration(prop.valueDeclaration)) {
      members.push(prop.valueDeclaration);
    }
  }
  return members;
}

/**
 * Given an existing array literal expression, update it by pushing a new expression.
 */
export function addElementToArrayLiteral(
  arr: ts.ArrayLiteralExpression,
  elem: ts.Expression,
): ts.ArrayLiteralExpression {
  return ts.factory.updateArrayLiteralExpression(arr, [...arr.elements, elem]);
}

/**
 * Given an ObjectLiteralExpression node, extract and return the PropertyAssignment corresponding to
 * the given key. `null` if no such key exists.
 */
export function objectPropertyAssignmentForKey(
  obj: ts.ObjectLiteralExpression,
  key: string,
): ts.PropertyAssignment | null {
  const matchingProperty = obj.properties.filter(
    (a) => a.name !== undefined && ts.isIdentifier(a.name) && a.name.escapedText === key,
  )[0];
  return matchingProperty && ts.isPropertyAssignment(matchingProperty) ? matchingProperty : null;
}

/**
 * Given an ObjectLiteralExpression node, create or update the specified key, using the provided
 * callback to generate the new value (possibly based on an old value), and return the `ts.PropertyAssignment`
 * for the key.
 */
export function updateObjectValueForKey(
  obj: ts.ObjectLiteralExpression,
  key: string,
  newValueFn: (oldValue?: ts.Expression) => ts.Expression,
): ts.PropertyAssignment {
  const existingProp = objectPropertyAssignmentForKey(obj, key);
  return ts.factory.createPropertyAssignment(
    ts.factory.createIdentifier(key),
    newValueFn(existingProp?.initializer),
  );
}

/**
 * Create a new ArrayLiteralExpression, or accept an existing one.
 * Ensure the array contains the provided identifier.
 * Returns the array, either updated or newly created.
 * If no update is needed, returns `null`.
 */
export function ensureArrayWithIdentifier(
  identifierText: string,
  expression: ts.Expression,
  arr?: ts.ArrayLiteralExpression,
): ts.ArrayLiteralExpression | null {
  if (arr === undefined) {
    return ts.factory.createArrayLiteralExpression([expression]);
  }
  if (arr.elements.find((v) => ts.isIdentifier(v) && v.text === identifierText)) {
    return null;
  }
  return ts.factory.updateArrayLiteralExpression(arr, [...arr.elements, expression]);
}

/**
 * Determine whether this an import of the given `propertyName` from a particular module
 * specifier already exists. If so, return the local name for that import, which might be an
 * alias.
 */
export function hasImport(
  importDeclarations: ts.ImportDeclaration[],
  propName: string,
  moduleSpecifier: string,
): string | null {
  return (
    importDeclarations
      .filter(
        (declaration) => getStringLiteralText(declaration.moduleSpecifier) === moduleSpecifier,
      )
      .map((declaration) => importHas(declaration, propName))
      .find((prop) => prop !== null) ?? null
  );
}

function nameInExportScope(importSpecifier: ts.ImportSpecifier): string {
  return importSpecifier.propertyName?.text ?? importSpecifier.name.text;
}

/**
 * Determine whether this import declaration already contains an import of the given
 * `propertyName`, and if so, the name it can be referred to with in the local scope.
 */
function importHas(importDecl: ts.ImportDeclaration, propName: string): string | null {
  const importClauseName = importDecl.importClause?.name?.getText();
  if (propName === 'default' && importClauseName !== undefined) {
    return importClauseName;
  }
  const bindings = importDecl.importClause?.namedBindings;
  if (bindings === undefined) {
    return null;
  }
  // First, we handle the case of explicit named imports.
  if (ts.isNamedImports(bindings)) {
    // Find any import specifier whose property name in the *export* scope equals the expected
    // name.
    const specifier = bindings.elements.find(
      (importSpecifier) => propName == nameInExportScope(importSpecifier),
    );
    // Return the name of the property in the *local* scope.
    if (specifier === undefined) {
      return null;
    }
    return specifier.name.text;
  }
  // The other case is a namespace import.
  return `${bindings.name.text}.${propName}`;
}

/**
 * Given an unqualified name, determine whether an existing import is already using this name in
 * the current scope.
 * TODO: It would be better to check if *any* symbol uses this name in the current scope.
 */
function importCollisionExists(importDeclaration: ts.ImportDeclaration[], name: string): boolean {
  const bindings = importDeclaration.map((declaration) => declaration.importClause?.namedBindings);
  const namedBindings: ts.NamedImports[] = bindings.filter(
    (binding) => binding !== undefined && ts.isNamedImports(binding),
  ) as ts.NamedImports[];
  const specifiers = namedBindings.flatMap((b) => b.elements);
  return specifiers.some((s) => s.name.text === name);
}

/**
 * Generator function that yields an infinite sequence of alternative aliases for a given symbol
 * name.
 */
function* suggestAlternativeSymbolNames(name: string): Iterator<string> {
  for (let i = 1; true; i++) {
    yield `${name}_${i}`; // The _n suffix is the same style as TS generated aliases
  }
}

/**
 * Transform the given import name into an alias that does not collide with any other import
 * symbol.
 */
export function nonCollidingImportName(
  importDeclarations: ts.ImportDeclaration[],
  name: string,
): string {
  const possibleNames = suggestAlternativeSymbolNames(name);
  while (importCollisionExists(importDeclarations, name)) {
    name = possibleNames.next().value;
  }
  return name;
}

/**
 * If the provided trait is standalone, just return it. Otherwise, returns the owning ngModule.
 */
export function standaloneTraitOrNgModule(
  checker: TemplateTypeChecker,
  trait: ts.ClassDeclaration,
): ts.ClassDeclaration | null {
  const componentDecorator = checker.getPrimaryAngularDecorator(trait);
  if (componentDecorator == null) {
    return null;
  }
  const owningNgModule = checker.getOwningNgModule(trait);
  const isMarkedStandalone = isStandaloneDecorator(componentDecorator);
  if (owningNgModule === null && !isMarkedStandalone) {
    // TODO(dylhunn): This is a "moduleless component." We should probably suggest the user add
    // `standalone: true`.
    return null;
  }
  return owningNgModule ?? trait;
}

/**
 * Updates the imports on a TypeScript file, by ensuring the provided import is present.
 * Returns the text changes, as well as the name with which the imported symbol can be referred to.
 *
 * When the component is exported by default, the `symbolName` is `default`, and the `declarationName`
 * should be used as the import name.
 */
export function updateImportsForTypescriptFile(
  file: ts.SourceFile,
  symbolName: string,
  declarationName: string,
  moduleSpecifier: string,
): [ts.TextChange[], string] {
  // The trait might already be imported, possibly under a different name. If so, determine the
  // local name of the imported trait.
  const allImports = findAllMatchingNodes(file, {filter: ts.isImportDeclaration});
  const existingImportName: string | null = hasImport(allImports, symbolName, moduleSpecifier);
  if (existingImportName !== null) {
    return [[], existingImportName];
  }

  // If the trait has not already been imported, we need to insert the new import.
  const existingImportDeclaration = allImports.find(
    (decl) => getStringLiteralText(decl.moduleSpecifier) === moduleSpecifier,
  );
  const importName = nonCollidingImportName(
    allImports,
    symbolName === 'default' ? declarationName : symbolName,
  );

  if (existingImportDeclaration !== undefined) {
    // Update an existing import declaration.
    const importClause = existingImportDeclaration.importClause;
    if (importClause === undefined) {
      return [[], ''];
    }
    let span = {start: importClause.getStart(), length: importClause.getWidth()};
    const updatedBindings = updateImport(existingImportDeclaration, symbolName, importName);
    if (updatedBindings === undefined) {
      return [[], ''];
    }
    const importString = printNode(updatedBindings, file);
    return [[{span, newText: importString}], importName];
  }

  // Find the last import in the file.
  let lastImport: ts.ImportDeclaration | null = null;
  file.forEachChild((child) => {
    if (ts.isImportDeclaration(child)) lastImport = child;
  });

  // Generate a new import declaration, and insert it after the last import declaration, only
  // looking at root nodes in the AST. If no import exists, place it at the start of the file.
  let span: ts.TextSpan = {start: 0, length: 0};
  if ((lastImport as any) !== null) {
    // TODO: Why does the compiler insist this is null?
    span.start = lastImport!.getStart() + lastImport!.getWidth();
  }
  const newImportDeclaration = generateImport(symbolName, importName, moduleSpecifier);
  const importString = '\n' + printNode(newImportDeclaration, file);
  return [[{span, newText: importString}], importName];
}

/**
 * Updates a given Angular trait, such as an NgModule or standalone Component, by adding
 * `importName` to the list of imports on the decorator arguments.
 */
export function updateImportsForAngularTrait(
  checker: TemplateTypeChecker,
  trait: ts.ClassDeclaration,
  importName: string,
  forwardRefName: string | null,
): ts.TextChange[] {
  // Get the object with arguments passed into the primary Angular decorator for this trait.
  const decorator = checker.getPrimaryAngularDecorator(trait);
  if (decorator === null) {
    return [];
  }
  const decoratorProps = findFirstMatchingNode(decorator, {filter: ts.isObjectLiteralExpression});
  if (decoratorProps === null) {
    return [];
  }

  /**
   * The assumption here is that there is a `template` or `templateUrl` in the decorator.
   */
  if (decoratorProps.properties.length === 0) {
    return [];
  }

  const lastProp = decoratorProps.properties[decoratorProps.properties.length - 1];
  const trailRange = ts.getTrailingCommentRanges(decoratorProps.getSourceFile().text, lastProp.end);
  const lastTrailRange =
    trailRange !== undefined && trailRange.length > 0
      ? trailRange[trailRange.length - 1]
      : undefined;
  const lastTrailRangePos = lastTrailRange?.end ?? lastProp.end;
  const oldImports = decoratorProps.properties.find((prop) => prop.name?.getText() === 'imports');

  let updateRequired = true;
  // Update the trait's imports.
  const newDecoratorProps = updateObjectValueForKey(
    decoratorProps,
    'imports',
    (oldValue?: ts.Expression) => {
      if (oldValue && !ts.isArrayLiteralExpression(oldValue)) {
        return oldValue;
      }
      const identifier = ts.factory.createIdentifier(importName);
      const expression = forwardRefName
        ? ts.factory.createCallExpression(ts.factory.createIdentifier(forwardRefName), undefined, [
            ts.factory.createArrowFunction(
              undefined,
              undefined,
              [],
              undefined,
              undefined,
              identifier,
            ),
          ])
        : identifier;
      const newArr = ensureArrayWithIdentifier(importName, expression, oldValue);
      updateRequired = newArr !== null;
      return newArr!;
    },
  );

  if (!updateRequired) {
    return [];
  }
  const indentationNumber = guessIndentationInSingleLine(lastProp, lastProp.getSourceFile());
  const indentationString = indentationNumber !== undefined ? ' '.repeat(indentationNumber) : '';
  let indentationPrefix = ',\n' + indentationString;
  /**
   * If the last trail range is a single line comment, the `,` should be placed in the next line and the
   * `imports` arrays should be placed in the next line of `,`.
   *
   * For example:
   *
   * {
   *   template: "" // this is a comment
   * }
   *
   * =>
   *
   * {
   *   template: "" // this is an comment
   *   ,
   *   imports: []
   * }
   */
  if (lastTrailRange?.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
    indentationPrefix = '\n' + indentationString + ',\n' + indentationString;
  }

  return [
    {
      /**
       * If the `imports` exists in the object, replace the old `imports` array with the new `imports` array.
       * If the `imports` doesn't exist in the object, append the `imports` array after the last property of the object.
       *
       * There is a weird usage, but it's acceptable. For example:
       *
       * {
       *   template: ``, // This is a comment for the template
       *  _____________^ // The new `imports` array is appended here before the `,`
       * }
       *
       * =>
       *
       * {
       *   template: ``,
       *   imports: [], // This is a comment for the template
       * }
       *
       */
      span: {
        start: oldImports !== undefined ? oldImports.getStart() : lastTrailRangePos,
        length: oldImports !== undefined ? oldImports.getEnd() - oldImports.getStart() : 0,
      },
      newText:
        (oldImports !== undefined ? '' : indentationPrefix) +
        printNode(newDecoratorProps, trait.getSourceFile()),
    },
  ];
}

/**
 * Return whether a given Angular decorator specifies `standalone: true`.
 */
export function isStandaloneDecorator(decorator: ts.Decorator): boolean | null {
  const decoratorProps = findFirstMatchingNode(decorator, {filter: ts.isObjectLiteralExpression});
  if (decoratorProps === null) {
    return null;
  }

  for (const property of decoratorProps.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    // TODO(dylhunn): What if this is a dynamically evaluated expression?
    if (property.name.getText() === 'standalone' && property.initializer.getText() === 'false') {
      return false;
    }
  }
  return true;
}

/**
 * Generate a new import. Follows the format:
 * ```ts
 * import {exportedSpecifierName as localName} from 'rawModuleSpecifier';
 * ```
 *
 * If the component is exported by default, follows the format:
 *
 * ```ts
 * import exportedSpecifierName from 'rawModuleSpecifier';
 * ```
 *
 * If `exportedSpecifierName` is null, or is equal to `name`, then the qualified import alias will
 * be omitted.
 */
export function generateImport(
  localName: string,
  exportedSpecifierName: string | null,
  rawModuleSpecifier: string,
): ts.ImportDeclaration {
  let propName: ts.Identifier | undefined;
  if (exportedSpecifierName !== null && exportedSpecifierName !== localName) {
    propName = ts.factory.createIdentifier(exportedSpecifierName);
  }
  const name = ts.factory.createIdentifier(localName);
  const moduleSpec = ts.factory.createStringLiteral(rawModuleSpecifier);
  let importClauseName: ts.Identifier | undefined;
  let importBindings: ts.NamedImportBindings | undefined;

  if (localName === 'default' && exportedSpecifierName !== null) {
    importClauseName = ts.factory.createIdentifier(exportedSpecifierName);
  } else {
    importBindings = ts.factory.createNamedImports([
      ts.factory.createImportSpecifier(false, propName, name),
    ]);
  }
  return ts.factory.createImportDeclaration(
    undefined,
    ts.factory.createImportClause(false, importClauseName, importBindings),
    moduleSpec,
    undefined,
  );
}

/**
 * Update an existing named import with a new member.
 * If `exportedSpecifierName` is null, or is equal to `name`, then the qualified import alias will
 * be omitted.
 * If the `localName` is `default` and `exportedSpecifierName` is not null, the `exportedSpecifierName`
 * is used as the default import name.
 */
export function updateImport(
  importDeclaration: ts.ImportDeclaration,
  localName: string,
  exportedSpecifierName: string | null,
): ts.ImportClause | undefined {
  const importClause = importDeclaration.importClause;
  if (importClause === undefined) {
    return undefined;
  }
  const bindings = importClause.namedBindings;
  if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
    // This should be impossible. If a namespace import is present, the symbol was already
    // considered imported above.
    console.error(`Unexpected namespace import ${importDeclaration.getText()}`);
    return undefined;
  }
  if (localName === 'default' && exportedSpecifierName !== null) {
    const importClauseName = ts.factory.createIdentifier(exportedSpecifierName);
    return ts.factory.updateImportClause(
      importClause,
      false,
      importClauseName,
      importClause.namedBindings,
    );
  }
  let propertyName: ts.Identifier | undefined;
  if (exportedSpecifierName !== null && exportedSpecifierName !== localName) {
    propertyName = ts.factory.createIdentifier(exportedSpecifierName);
  }
  const name = ts.factory.createIdentifier(localName);
  const newImport = ts.factory.createImportSpecifier(false, propertyName, name);
  let namedImport: ts.NamedImports;
  if (bindings === undefined) {
    namedImport = ts.factory.createNamedImports([newImport]);
  } else {
    namedImport = ts.factory.updateNamedImports(bindings, [...bindings.elements, newImport]);
  }
  return ts.factory.updateImportClause(importClause, false, importClause.name, namedImport);
}

let printer: ts.Printer | null = null;

/**
 * Get a ts.Printer for printing AST nodes, reusing the previous Printer if already created.
 */
function getOrCreatePrinter(): ts.Printer {
  if (printer === null) {
    printer = ts.createPrinter();
  }
  return printer;
}

/**
 * Print a given TypeScript node into a string. Used to serialize entirely synthetic generated AST,
 * which will not have `.text` or `.fullText` set.
 */
export function printNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return getOrCreatePrinter().printNode(ts.EmitHint.Unspecified, node, sourceFile);
}

/**
 * Get the code actions to tell the vscode how to import the directive into the standalone component or ng module.
 */
export function getCodeActionToImportTheDirectiveDeclaration(
  compiler: NgCompiler,
  component: ts.ClassDeclaration,
  importOn: ts.ClassDeclaration,
  directive: PotentialDirective | PotentialPipe,
  tsLs: ts.LanguageService,
  includeCompletionsForModuleExports?: boolean,
): ts.CodeAction[] | undefined {
  const codeActions: ts.CodeAction[] = [];

  const potentialDirectiveModuleSpecifierResolver =
    new PotentialDirectiveModuleSpecifierResolverImpl(
      compiler,
      directive,
      compiler.getTemplateTypeChecker(),
      component,
      tsLs,
      includeCompletionsForModuleExports,
    );
  const potentialImports = compiler
    .getTemplateTypeChecker()
    .getPotentialImportsFor(
      directive.ref,
      importOn,
      PotentialImportMode.Normal,
      potentialDirectiveModuleSpecifierResolver,
    );
  const declarationName = directive.ref.node.name.getText();

  for (const potentialImport of potentialImports) {
    const fileImportChanges: ts.TextChange[] = [];
    let importName: string;
    let forwardRefName: string | null = null;

    if (potentialImport.moduleSpecifier) {
      const [importChanges, generatedImportName] = updateImportsForTypescriptFile(
        importOn.getSourceFile(),
        potentialImport.symbolName,
        declarationName,
        potentialImport.moduleSpecifier,
      );
      importName = generatedImportName;
      fileImportChanges.push(...importChanges);
    } else {
      if (potentialImport.isForwardReference) {
        // Note that we pass the `importOn` file twice since we know that the potential import
        // is within the same file, because it doesn't have a `moduleSpecifier`.
        const [forwardRefImports, generatedForwardRefName] = updateImportsForTypescriptFile(
          importOn.getSourceFile(),
          'forwardRef',
          declarationName,
          '@angular/core',
        );
        fileImportChanges.push(...forwardRefImports);
        forwardRefName = generatedForwardRefName;
      }
      importName = potentialImport.symbolName;
    }

    // Always update the trait import, although the TS import might already be present.
    const traitImportChanges = updateImportsForAngularTrait(
      compiler.getTemplateTypeChecker(),
      importOn,
      importName,
      forwardRefName,
    );
    if (traitImportChanges.length === 0) continue;

    let description = `Import ${importName}`;
    if (potentialImport.moduleSpecifier !== undefined) {
      description += ` from '${potentialImport.moduleSpecifier}' on ${importOn.name!.text}`;
    }
    codeActions.push({
      description,
      changes: [
        {
          fileName: importOn.getSourceFile().fileName,
          textChanges: [...fileImportChanges, ...traitImportChanges],
        },
      ],
    });
  }

  return codeActions;
}

function getStringLiteralText(moduleSpecifier: ts.Expression): string | undefined {
  if (ts.isStringLiteral(moduleSpecifier)) {
    return moduleSpecifier.text;
  }
  return undefined;
}

/**
 * Try to compute the module specifier after applying the paths from tsconfig or package.json export rules.
 *
 * Try to reuse the module specifier if the import in the `importOn` can export the `toImport` node.
 *
 * If a module specifier cannot be resolved, return undefined, and the Angular compiler will apply its own rules.
 *
 * There is one exception here. For example
 *
 * ```ts
 * // app.ts
 * @Component({
 *     selector: 'app-foo',
 *     template: '',
 * })
 * export class FooComponent {}
 *
 * @Component({
 *     selector: 'app-bar',
 *     template: '',
 * })
 *
 * export class BarComponent {}
 *
 * ```
 *
 * ```ts
 * // app.module.ts
 * import {BarComponent} from "./app";
 * @NgModule({
 *     declarations: [BarComponent],
 *     exports: [BarComponent],
 *     imports: []
 * })
 * export class AppModule {}
 * ```
 *
 * ```ts
 * // test.ts
 * // The `@/app.module` resolves to `./app.module.ts`.
 * // The `@/app` resolves to `./app`.
 * // It's configured in the `paths` in the tsconfig.
 * import {AppModule} from "@/app.module";
 *
 * @Component({
 *     selector: 'app-baz',
 *     template: '<app-bar/><app-foo/>',
 *     imports: [AppModule],
 * })
 * export class BazComponent {}
 * ```
 *
 * When providing the code action for the `app-foo` in the `test.ts` file,
 * the module specifier is `./app.ts`, not `@/app`. Because the TCB has imported
 * the `./app.ts` for the `app-bar`, the tsLs will reuse the import statement
 * in the TCB, no module specifier can be extracted, and the `@/app.module` doesn't
 * export the `FooComponent`. So the module specifier will be generated by
 * the Angular compiler.
 *
 * The developer should export the `FooComponent` in the `AppModule`.
 *
 */
class PotentialDirectiveModuleSpecifierResolverImpl
  implements PotentialDirectiveModuleSpecifierResolver
{
  constructor(
    private readonly compiler: NgCompiler,
    private readonly directive: PotentialDirective | PotentialPipe,
    private readonly templateTypeChecker: TemplateTypeChecker,
    private readonly component: ts.ClassDeclaration,
    private readonly tsLS: ts.LanguageService,
    private readonly includeCompletionsForModuleExports: boolean | undefined,
  ) {}

  resolve(toImport: Reference<ClassDeclaration>, importOn: ts.Node | null): string | undefined {
    if (toImport.node.getSourceFile().fileName === importOn?.getSourceFile().fileName) {
      return undefined;
    }
    const moduleSpecifier = getModuleSpecifierIfExists(this.compiler, importOn, toImport.node);

    if (moduleSpecifier !== null) {
      return moduleSpecifier;
    }

    return getModuleSpecifierFromImportStatement(
      this.directive.tsCompletionEntryInfos,
      toImport,
      importOn,
      this.templateTypeChecker,
      this.component,
      this.tsLS,
      this.includeCompletionsForModuleExports,
    );
  }
}

const importRegex = /\bimport\b[\s\S]*?\bfrom\b\s*(['"`])(.*?)\1/;
/**
 * Get the module specifier from the code actions returned by the `ls.getCompletionEntryDetails`.
 *
 * If the directive needs to update the import statement, the code action will include the text
 * like `i0.FooComponent`.
 *
 * If the directive needs to import a new external module, the code action will include the text
 * like `import { FooComponent } from '@foo'`. The `@foo` will be returned by the function.
 */
function getModuleSpecifierFromImportStatement(
  tsCompletionEntryInfos: TsCompletionEntryInfo[] | null,
  toImport: Reference<ClassDeclaration>,
  importOn: ts.Node | null,
  templateTypeChecker: TemplateTypeChecker,
  component: ts.ClassDeclaration,
  tsLS: ts.LanguageService,
  includeCompletionsForModuleExports: boolean | undefined,
): string | undefined {
  const tsCompletionEntryInfo = findTsCompletionEntryInfoForImport(
    tsCompletionEntryInfos,
    toImport,
  );

  if (tsCompletionEntryInfo === undefined) {
    return undefined;
  }

  const tsEntryName = tsCompletionEntryInfo.tsCompletionEntrySymbolName;

  const globalContext = templateTypeChecker.getGlobalTsContext(component);
  if (globalContext === null) {
    return undefined;
  }

  const completionListDetail = tsLS.getCompletionEntryDetails(
    globalContext.tcbPath,
    globalContext.positionInFile,
    tsEntryName,
    {},
    undefined,
    {
      includeCompletionsForModuleExports,
    },
    tsCompletionEntryInfo.tsCompletionEntryData,
  );

  const actions = completionListDetail?.codeActions;
  if (actions === undefined) {
    return undefined;
  }

  const tcbDir = path.posix.dirname(globalContext.tcbPath);
  const importOnDir = importOn ? path.posix.dirname(importOn.getSourceFile().fileName) : undefined;

  for (const action of actions) {
    for (const changes of action.changes) {
      for (const textChange of changes.textChanges) {
        const match = importRegex.exec(textChange.newText);
        if (match !== null) {
          let moduleSpecifier = match[2];
          /**
           * The TCB path may differ from the ng module path. If the module specifier is a relative path,
           * it must be relative to the NG module path.
           */
          if (
            moduleSpecifier.startsWith('.') &&
            tcbDir !== importOnDir &&
            importOnDir !== undefined
          ) {
            const moduleSpecifierFullPath = path.posix.resolve(tcbDir, moduleSpecifier);
            moduleSpecifier = path.posix.relative(importOnDir, moduleSpecifierFullPath);
            if (!moduleSpecifier.startsWith('.')) {
              moduleSpecifier = `./${moduleSpecifier}`;
            }
          }
          return moduleSpecifier;
        }
      }
    }
  }
  return undefined;
}

function findTsCompletionEntryInfoForImport(
  tsCompletionEntryInfos: TsCompletionEntryInfo[] | null,
  toImport: Reference<ClassDeclaration>,
): TsCompletionEntryInfo | undefined {
  const toImportSymbolName = toImport.node.name?.text;
  const toImportSymbolFileName = toImport.node.getSourceFile().fileName;

  return tsCompletionEntryInfos?.find(
    (entry) =>
      entry.tsCompletionEntrySymbolName === toImportSymbolName &&
      entry.tsCompletionEntrySymbolFileName === toImportSymbolFileName,
  );
}

function moduleSpecifierPointsToSymbol(
  tsChecker: ts.TypeChecker,
  moduleSpecifier: ts.Expression,
): ts.Symbol | null {
  const specifierSymbol = tsChecker.getSymbolAtLocation(moduleSpecifier);
  if (specifierSymbol === undefined) {
    console.error(`Undefined symbol for module specifier ${moduleSpecifier.getText()}`);
    return null;
  }
  const symbolDeclarations = specifierSymbol.declarations;
  if (symbolDeclarations === undefined || symbolDeclarations.length === 0) {
    console.error(`Unknown symbol declarations for module specifier ${moduleSpecifier.getText()}`);
    return null;
  }

  if (symbolDeclarations.length > 0) {
    const sf = symbolDeclarations[0].getSourceFile();
    return tsChecker.getSymbolAtLocation(sf) ?? null;
  }

  return null;
}

/**
 * Retrieve all imports from the `importOn` and check if any import can export the node specified by `toImport`.
 * If a matching import is found, attempt to reuse it.
 */
function getModuleSpecifierIfExists(
  compiler: NgCompiler,
  importOn: ts.Node | null,
  toImport: ClassDeclaration,
): string | null {
  if (importOn === null) {
    return null;
  }

  const allImports = findAllMatchingNodes(importOn.getSourceFile(), {
    filter: ts.isImportDeclaration,
  });

  const typeChecker = compiler.getCurrentProgram().getTypeChecker();

  for (const importDecl of allImports) {
    const importSymbol = moduleSpecifierPointsToSymbol(typeChecker, importDecl.moduleSpecifier);

    if (importSymbol === null) {
      continue;
    }

    const toImportSymbolFromModule = typeChecker.tryGetMemberInModuleExports(
      toImport.name.getText(),
      importSymbol,
    );

    /**
     * Make sure these are the same node.
     */
    if (toImportSymbolFromModule?.declarations?.[0] === toImport) {
      return getStringLiteralText(importDecl.moduleSpecifier) ?? null;
    }
  }

  return null;
}
