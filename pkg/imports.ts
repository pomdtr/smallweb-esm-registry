import { Project, SyntaxKind, Node } from 'ts-morph';
import type { ImportDeclaration, ExportDeclaration, CallExpression, StringLiteral, NoSubstitutionTemplateLiteral, BinaryExpression, AwaitExpression, SourceFile } from 'ts-morph';

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
        const cleanSpecifier = specifier.replace(/^['"`]|['"`]$/g, '');

        if (this.imports[cleanSpecifier]) {
            return this.imports[cleanSpecifier];
        }

        for (const [key, value] of Object.entries(this.imports)) {
            if (cleanSpecifier.startsWith(key + '/')) {
                return value.replace(/\/$/, '') + cleanSpecifier.slice(key.length);
            }
        }

        return cleanSpecifier;
    }

    /**
     * Processes @jsxImportSource comments
     */
    private processJsxImportSourceComment(sourceFile: SourceFile): void {
        const firstStatement = sourceFile.getStatements()[0];

        const commentRanges = firstStatement
            ? firstStatement.getLeadingCommentRanges()
            : sourceFile.getLeadingCommentRanges();

        commentRanges.forEach(comment => {
            const text = comment.getText();
            const match = text.match(/@jsxImportSource\s+([^\s*]+)/);

            if (match) {
                const originalSpecifier = match[1];
                const resolvedSpecifier = this.resolveSpecifier(originalSpecifier);

                if (resolvedSpecifier !== originalSpecifier) {
                    // Replace by editing the full text of the source file
                    const start = comment.getPos();
                    const end = comment.getEnd();
                    sourceFile.replaceText([start, end], text.replace(originalSpecifier, resolvedSpecifier));
                }
            }
        });
    }

    private processImportDeclaration(node: ImportDeclaration): void {
        const moduleSpecifier = node.getModuleSpecifier();
        if (!Node.isStringLiteral(moduleSpecifier)) return;

        const originalSpecifier = moduleSpecifier.getLiteralValue();
        const resolvedSpecifier = this.resolveSpecifier(originalSpecifier);

        if (resolvedSpecifier !== originalSpecifier) {
            moduleSpecifier.setLiteralValue(resolvedSpecifier);
        }
    }

    private processExportDeclaration(node: ExportDeclaration): void {
        const moduleSpecifier = node.getModuleSpecifier();
        if (!moduleSpecifier || !Node.isStringLiteral(moduleSpecifier)) return;

        const originalSpecifier = moduleSpecifier.getLiteralValue();
        const resolvedSpecifier = this.resolveSpecifier(originalSpecifier);

        if (resolvedSpecifier !== originalSpecifier) {
            moduleSpecifier.setLiteralValue(resolvedSpecifier);
        }
    }

    private processDynamicImport(node: CallExpression): void {
        const expression = node.getExpression();

        if (!Node.isIdentifier(expression) || expression.getText() !== 'import') {
            return;
        }

        const args = node.getArguments();
        if (args.length === 0) return;

        const firstArg = args[0];

        if (Node.isStringLiteral(firstArg)) {
            this.processStringLiteralArg(firstArg);
        } else if (Node.isNoSubstitutionTemplateLiteral(firstArg)) {
            this.processTemplateLiteralArg(firstArg);
        } else if (Node.isBinaryExpression(firstArg)) {
            this.processBinaryExpressionArg(firstArg);
        }
    }

    private processStringLiteralArg(node: StringLiteral): void {
        const originalSpecifier = node.getLiteralValue();
        const resolvedSpecifier = this.resolveSpecifier(originalSpecifier);

        if (resolvedSpecifier !== originalSpecifier) {
            node.setLiteralValue(resolvedSpecifier);
        }
    }

    private processTemplateLiteralArg(node: NoSubstitutionTemplateLiteral): void {
        const originalSpecifier = node.getLiteralValue();
        const resolvedSpecifier = this.resolveSpecifier(originalSpecifier);

        if (resolvedSpecifier !== originalSpecifier) {
            node.setLiteralValue(resolvedSpecifier);
        }
    }

    private processBinaryExpressionArg(node: BinaryExpression): void {
        const operator = node.getOperatorToken();

        if (operator.getKind() !== SyntaxKind.PlusToken) return;

        const left = node.getLeft();
        const right = node.getRight();

        if (Node.isStringLiteral(left)) {
            this.processStringLiteralArg(left);
        }
        if (Node.isStringLiteral(right)) {
            this.processStringLiteralArg(right);
        }
    }

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
            const sourceFile = this.project.createSourceFile(filePath, sourceCode, {
                overwrite: true,
            });

            // Process @jsxImportSource comments
            this.processJsxImportSourceComment(sourceFile);

            sourceFile.getImportDeclarations().forEach(importDecl => {
                this.processImportDeclaration(importDecl);
            });

            sourceFile.getExportDeclarations().forEach(exportDecl => {
                this.processExportDeclaration(exportDecl);
            });

            sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).forEach(callExpr => {
                this.processDynamicImport(callExpr);
            });

            sourceFile.getDescendantsOfKind(SyntaxKind.AwaitExpression).forEach(awaitExpr => {
                this.processAwaitExpression(awaitExpr);
            });

            return sourceFile.getFullText();
        } catch (error) {
            console.error('Error processing with ts-morph:', error);
            throw new Error(`Failed to rewrite imports in ${filePath}`);
        }
    }
}
