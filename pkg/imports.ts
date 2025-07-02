import { Project, SyntaxKind, Node, ImportDeclaration, ExportDeclaration, CallExpression, StringLiteral, NoSubstitutionTemplateLiteral, BinaryExpression, AwaitExpression } from 'ts-morph';

export class ImportRewriter {
    private project: Project;
    private imports: Record<string, string>;

    constructor(imports: Record<string, string>) {
        this.project = new Project({
            useInMemoryFileSystem: true,
            compilerOptions: {
                target: 99, // Latest
                module: 99, // ESNext
                allowJs: true,
                allowSyntheticDefaultImports: true,
                esModuleInterop: true,
            },
        });
        this.imports = imports;
    }

    /**
     * Resolves a module specifier using the import map
     */
    private resolveSpecifier(specifier: string): string {
        // Remove quotes if present
        const cleanSpecifier = specifier.replace(/^['"`]|['"`]$/g, '');

        // Check for exact match first
        if (this.imports[cleanSpecifier]) {
            return this.imports[cleanSpecifier];
        }

        // Check for subpath imports
        for (const [key, value] of Object.entries(this.imports)) {
            if (cleanSpecifier.startsWith(key + '/')) {
                // Replace the key part with the resolved value
                return value.replace(/\/$/, '') + cleanSpecifier.slice(key.length);
            }
        }

        return cleanSpecifier;
    }

    /**
     * Processes static import declarations
     */
    private processImportDeclaration(node: ImportDeclaration): void {
        const moduleSpecifier = node.getModuleSpecifier();
        if (!Node.isStringLiteral(moduleSpecifier)) return;

        const originalSpecifier = moduleSpecifier.getLiteralValue();
        const resolvedSpecifier = this.resolveSpecifier(originalSpecifier);

        if (resolvedSpecifier !== originalSpecifier) {
            moduleSpecifier.setLiteralValue(resolvedSpecifier);
        }
    }

    /**
     * Processes static export declarations
     */
    private processExportDeclaration(node: ExportDeclaration): void {
        const moduleSpecifier = node.getModuleSpecifier();
        if (!moduleSpecifier || !Node.isStringLiteral(moduleSpecifier)) return;

        const originalSpecifier = moduleSpecifier.getLiteralValue();
        const resolvedSpecifier = this.resolveSpecifier(originalSpecifier);

        if (resolvedSpecifier !== originalSpecifier) {
            moduleSpecifier.setLiteralValue(resolvedSpecifier);
        }
    }

    /**
     * Processes dynamic import() calls
     */
    private processDynamicImport(node: CallExpression): void {
        const expression = node.getExpression();

        // Check if this is an import() call
        if (!Node.isIdentifier(expression) || expression.getText() !== 'import') {
            return;
        }

        const args = node.getArguments();
        if (args.length === 0) return;

        const firstArg = args[0];

        // Handle different types of arguments
        if (Node.isStringLiteral(firstArg)) {
            this.processStringLiteralArg(firstArg);
        } else if (Node.isNoSubstitutionTemplateLiteral(firstArg)) {
            this.processTemplateLiteralArg(firstArg);
        } else if (Node.isBinaryExpression(firstArg)) {
            this.processBinaryExpressionArg(firstArg);
        }
        // Skip other types like identifiers (variables) as they can't be resolved statically
    }

    /**
     * Processes string literal arguments in dynamic imports
     */
    private processStringLiteralArg(node: StringLiteral): void {
        const originalSpecifier = node.getLiteralValue();
        const resolvedSpecifier = this.resolveSpecifier(originalSpecifier);

        if (resolvedSpecifier !== originalSpecifier) {
            node.setLiteralValue(resolvedSpecifier);
        }
    }

    /**
     * Processes template literal arguments in dynamic imports
     */
    private processTemplateLiteralArg(node: NoSubstitutionTemplateLiteral): void {
        const originalSpecifier = node.getLiteralValue();
        const resolvedSpecifier = this.resolveSpecifier(originalSpecifier);

        if (resolvedSpecifier !== originalSpecifier) {
            node.setLiteralValue(resolvedSpecifier);
        }
    }

    /**
     * Processes binary expression arguments in dynamic imports (string concatenation)
     */
    private processBinaryExpressionArg(node: BinaryExpression): void {
        const operator = node.getOperatorToken();

        // Only handle addition (string concatenation)
        if (operator.getKind() !== SyntaxKind.PlusToken) return;

        const left = node.getLeft();
        const right = node.getRight();

        // Process string literals in the concatenation
        if (Node.isStringLiteral(left)) {
            this.processStringLiteralArg(left);
        }
        if (Node.isStringLiteral(right)) {
            this.processStringLiteralArg(right);
        }
    }

    /**
     * Processes await expressions that might contain dynamic imports
     */
    private processAwaitExpression(node: AwaitExpression): void {
        const expression = node.getExpression();
        if (Node.isCallExpression(expression)) {
            this.processDynamicImport(expression);
        }
    }

    /**
     * Main method to rewrite imports in source code
     */
    public rewriteImports(sourceCode: string, filePath: string): string {
        try {
            // Create a source file in the project
            const sourceFile = this.project.createSourceFile(filePath, sourceCode, {
                overwrite: true,
            });

            // Process all import declarations
            sourceFile.getImportDeclarations().forEach(importDecl => {
                this.processImportDeclaration(importDecl);
            });

            // Process all export declarations
            sourceFile.getExportDeclarations().forEach(exportDecl => {
                this.processExportDeclaration(exportDecl);
            });

            // Process all call expressions (for dynamic imports)
            sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(callExpr => {
                this.processDynamicImport(callExpr);
            });

            // Process await expressions
            sourceFile.getDescendantsOfKind(SyntaxKind.AwaitExpression).forEach(awaitExpr => {
                this.processAwaitExpression(awaitExpr);
            });

            // Return the transformed code
            return sourceFile.getFullText();
        } catch (error) {
            console.error('Error processing with ts-morph:', error);
            // Fallback to string-based replacement
            throw new Error(`Failed to rewrite imports in ${filePath}`);
        }
    }
}
