/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from 'vs/base/browser/dom';
import { Disposable, DisposableStore } from 'vs/base/common/lifecycle';
import { IDiffEditorOptions, IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { CellDiffViewModel, PropertyFoldingState } from 'vs/workbench/contrib/notebook/browser/diff/celllDiffViewModel';
import { CellDiffRenderTemplate, CellDiffViewModelLayoutChangeEvent, DIFF_CELL_MARGIN, INotebookTextDiffEditor } from 'vs/workbench/contrib/notebook/browser/diff/common';
import { EDITOR_BOTTOM_PADDING, EDITOR_TOP_PADDING } from 'vs/workbench/contrib/notebook/browser/constants';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { DiffEditorWidget } from 'vs/editor/browser/widget/diffEditorWidget';
import { renderCodicons } from 'vs/base/common/codicons';
import { IModelService } from 'vs/editor/common/services/modelService';
import { IModeService } from 'vs/editor/common/services/modeService';
import { format } from 'vs/base/common/jsonFormatter';
import { applyEdits } from 'vs/base/common/jsonEdit';
import { NotebookCellMetadata } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { hash } from 'vs/base/common/hash';

const fixedEditorOptions: IEditorOptions = {
	padding: {
		top: 12,
		bottom: 12
	},
	scrollBeyondLastLine: false,
	scrollbar: {
		verticalScrollbarSize: 14,
		horizontal: 'auto',
		useShadows: true,
		verticalHasArrows: false,
		horizontalHasArrows: false,
		alwaysConsumeMouseWheel: false
	},
	renderLineHighlightOnlyWhenFocus: true,
	overviewRulerLanes: 0,
	selectOnLineNumbers: false,
	wordWrap: 'off',
	lineNumbers: 'off',
	lineDecorationsWidth: 0,
	glyphMargin: false,
	fixedOverflowWidgets: true,
	minimap: { enabled: false },
	renderValidationDecorations: 'on',
	renderLineHighlight: 'none',
	readOnly: true
};

const fixedDiffEditorOptions: IDiffEditorOptions = {
	...fixedEditorOptions,
	glyphMargin: true,
	enableSplitViewResizing: false,
	renderIndicators: false,
};



class PropertyHeader extends Disposable {
	protected _foldingIndicator!: HTMLElement;
	protected _statusSpan!: HTMLElement;

	constructor(
		readonly cell: CellDiffViewModel,
		readonly metadataHeaderContainer: HTMLElement,
		readonly notebookEditor: INotebookTextDiffEditor,
		readonly accessor: {
			updateInfoRendering: () => void;
			checkIfModified: (cell: CellDiffViewModel) => boolean;
			getFoldingState: (cell: CellDiffViewModel) => PropertyFoldingState;
			updateFoldingState: (cell: CellDiffViewModel, newState: PropertyFoldingState) => void;
			unChangedLabel: string;
			changedLabel: string;
			prefix: string;
		}
	) {
		super();
	}

	buildHeader(): void {
		let metadataChanged = this.accessor.checkIfModified(this.cell);
		this._foldingIndicator = DOM.append(this.metadataHeaderContainer, DOM.$('.property-folding-indicator'));
		DOM.addClass(this._foldingIndicator, this.accessor.prefix);


		this._updateFoldingIcon();
		const metadataStatus = DOM.append(this.metadataHeaderContainer, DOM.$('div.property-status'));
		this._statusSpan = DOM.append(metadataStatus, DOM.$('span'));

		if (metadataChanged) {
			this._statusSpan.textContent = this.accessor.changedLabel;
			this._statusSpan.style.fontWeight = 'bold';
			DOM.addClass(this.metadataHeaderContainer, 'modified');
		} else {
			this._statusSpan.textContent = this.accessor.unChangedLabel;
		}

		this._register(this.notebookEditor.onMouseUp(e => {
			if (!e.event.target) {
				return;
			}

			const target = e.event.target as HTMLElement;

			if (DOM.hasClass(target, 'codicon-chevron-down') || DOM.hasClass(target, 'codicon-chevron-right')) {
				const parent = target.parentElement as HTMLElement;

				if (!parent) {
					return;
				}

				if (!DOM.hasClass(parent, this.accessor.prefix)) {
					return;
				}

				if (!DOM.hasClass(parent, 'property-folding-indicator')) {
					return;
				}

				// folding icon

				const cellViewModel = e.target;

				if (cellViewModel === this.cell) {
					const oldFoldingState = this.accessor.getFoldingState(this.cell);
					this.accessor.updateFoldingState(this.cell, oldFoldingState === PropertyFoldingState.Expanded ? PropertyFoldingState.Collapsed : PropertyFoldingState.Expanded);
					this._updateFoldingIcon();
					this.accessor.updateInfoRendering();
				}
			}

			return;
		}));

		this._updateFoldingIcon();
		this.accessor.updateInfoRendering();
	}

	private _updateFoldingIcon() {
		if (this.accessor.getFoldingState(this.cell) === PropertyFoldingState.Collapsed) {
			this._foldingIndicator.innerHTML = renderCodicons('$(chevron-right)');
		} else {
			this._foldingIndicator.innerHTML = renderCodicons('$(chevron-down)');
		}
	}
}

abstract class AbstractCellRenderer extends Disposable {
	protected _metadataHeaderContainer!: HTMLElement;
	protected _metadataHeader!: PropertyHeader;
	protected _metadataInfoContainer!: HTMLElement;
	protected _metadataEditorContainer?: HTMLElement;
	protected _metadataEditorDisposeStore!: DisposableStore;
	protected _metadataEditor?: CodeEditorWidget | DiffEditorWidget;

	protected _outputHeaderContainer!: HTMLElement;
	protected _outputHeader!: PropertyHeader;
	protected _outputInfoContainer!: HTMLElement;
	protected _outputEditorContainer?: HTMLElement;
	protected _outputEditorDisposeStore!: DisposableStore;
	protected _outputEditor?: CodeEditorWidget | DiffEditorWidget;


	protected _diffEditorContainer!: HTMLElement;
	protected _diagonalFill?: HTMLElement;
	protected _layoutInfo!: {
		editorHeight: number;
		editorMargin: number;
		metadataStatusHeight: number;
		metadataHeight: number;
		outputStatusHeight: number;
		outputHeight: number;
		bodyMargin: number;
	};

	constructor(
		readonly notebookEditor: INotebookTextDiffEditor,
		readonly cell: CellDiffViewModel,
		readonly templateData: CellDiffRenderTemplate,
		readonly style: 'left' | 'right' | 'full',
		protected readonly instantiationService: IInstantiationService,
		protected readonly modeService: IModeService,
		protected readonly modelService: IModelService,

	) {
		super();
		// init
		this._layoutInfo = {
			editorHeight: 0,
			editorMargin: 0,
			metadataHeight: 0,
			metadataStatusHeight: 25,
			outputHeight: 0,
			outputStatusHeight: 25,
			bodyMargin: 32
		};
		this._metadataEditorDisposeStore = new DisposableStore();
		this._outputEditorDisposeStore = new DisposableStore();
		this._register(this._metadataEditorDisposeStore);
		this.initData();
		this.buildBody(templateData.container);
		this._register(cell.onDidLayoutChange(e => this.onDidLayoutChange(e)));
	}

	buildBody(container: HTMLElement) {
		const body = DOM.$('.cell-body');
		DOM.append(container, body);
		this._diffEditorContainer = DOM.$('.cell-diff-editor-container');
		switch (this.style) {
			case 'left':
				DOM.addClass(body, 'left');
				break;
			case 'right':
				DOM.addClass(body, 'right');
				break;
			default:
				DOM.addClass(body, 'full');
				break;
		}

		DOM.append(body, this._diffEditorContainer);
		this._diagonalFill = DOM.append(body, DOM.$('.diagonal-fill'));
		this.styleContainer(this._diffEditorContainer);
		const sourceContainer = DOM.append(this._diffEditorContainer, DOM.$('.source-container'));
		this.buildSourceEditor(sourceContainer);

		this._metadataHeaderContainer = DOM.append(this._diffEditorContainer, DOM.$('.metadata-header-container'));
		this._metadataInfoContainer = DOM.append(this._diffEditorContainer, DOM.$('.metadata-info-container'));

		this._metadataHeader = new PropertyHeader(
			this.cell,
			this._metadataHeaderContainer,
			this.notebookEditor,
			{
				updateInfoRendering: this.updateMetadataRendering.bind(this),
				checkIfModified: (cell) => {
					return cell.type === 'modified' && hash(this._getFormatedMetadataJSON(cell.original?.metadata || {})) !== hash(this._getFormatedMetadataJSON(cell.modified?.metadata ?? {}));
				},
				getFoldingState: (cell) => {
					return cell.metadataFoldingState;
				},
				updateFoldingState: (cell, state) => {
					cell.metadataFoldingState = state;
				},
				unChangedLabel: 'Metadata',
				changedLabel: 'Metadata changed',
				prefix: 'metadata'
			}
		);
		this._register(this._metadataHeader);
		this._metadataHeader.buildHeader();

		this._outputHeaderContainer = DOM.append(this._diffEditorContainer, DOM.$('.output-header-container'));
		this._outputInfoContainer = DOM.append(this._diffEditorContainer, DOM.$('.output-info-container'));

		this._outputHeader = new PropertyHeader(
			this.cell,
			this._outputHeaderContainer,
			this.notebookEditor,
			{
				updateInfoRendering: this.updateOutputRendering.bind(this),
				checkIfModified: (cell) => {
					return !this.notebookEditor.textModel!.transientOptions.transientOutputs && cell.type === 'modified' && hash(cell.original?.outputs ?? []) !== hash(cell.modified?.outputs ?? []);
				},
				getFoldingState: (cell) => {
					return this.cell.outputFoldingState;
				},
				updateFoldingState: (cell, state) => {
					cell.outputFoldingState = state;
				},
				unChangedLabel: 'Outputs',
				changedLabel: 'Outputs changed',
				prefix: 'output'
			}
		);
		this._register(this._outputHeader);
		this._outputHeader.buildHeader();
	}

	updateMetadataRendering() {
		if (this.cell.metadataFoldingState === PropertyFoldingState.Expanded) {
			// we should expand the metadata editor
			this._metadataInfoContainer.style.display = 'block';

			if (!this._metadataEditorContainer || !this._metadataEditor) {
				// create editor
				this._metadataEditorContainer = DOM.append(this._metadataInfoContainer, DOM.$('.metadata-editor-container'));
				this._buildMetadataEditor();
			} else {
				this._layoutInfo.metadataHeight = this._metadataEditor.getContentHeight();
				this.layout({ metadataEditor: true });
			}
		} else {
			// we should collapse the metadata editor
			this._metadataInfoContainer.style.display = 'none';
			this._metadataEditorDisposeStore.clear();
			this._layoutInfo.metadataHeight = 0;
			this.layout({});
		}
	}

	updateOutputRendering() {
		if (this.cell.outputFoldingState === PropertyFoldingState.Expanded) {
			this._outputInfoContainer.style.display = 'block';

			if (!this._outputEditorContainer || !this._outputEditor) {
				// create editor
				this._outputEditorContainer = DOM.append(this._outputInfoContainer, DOM.$('.output-editor-container'));
				this._buildOutputEditor();
			} else {
				console.log(this.cell);
				this._layoutInfo.outputHeight = this._outputEditor.getContentHeight();
				this.layout({ outputEditor: true });
			}
		} else {
			this._outputInfoContainer.style.display = 'none';
			this._outputEditorDisposeStore.clear();
			this._layoutInfo.outputHeight = 0;
			this.layout({});
		}
	}

	protected _getFormatedMetadataJSON(metadata: NotebookCellMetadata, language?: string) {
		let filteredMetadata: { [key: string]: any } = {};
		if (this.notebookEditor.textModel) {
			const transientMetadata = this.notebookEditor.textModel!.transientOptions.transientMetadata;

			const keys = new Set([...Object.keys(metadata)]);
			for (let key of keys) {
				if (!(transientMetadata[key as keyof NotebookCellMetadata])
				) {
					filteredMetadata[key] = metadata[key as keyof NotebookCellMetadata];
				}
			}
		} else {
			filteredMetadata = metadata;
		}

		const content = JSON.stringify({
			language,
			...filteredMetadata
		});

		const edits = format(content, undefined, {});
		const metadataSource = applyEdits(content, edits);

		return metadataSource;
	}

	private _buildMetadataEditor() {
		if (this.cell.type === 'modified') {
			const originalMetadataSource = this._getFormatedMetadataJSON(this.cell.original?.metadata || {}, this.cell.original?.language);
			const modifiedMetadataSource = this._getFormatedMetadataJSON(this.cell.modified?.metadata || {}, this.cell.modified?.language);
			if (originalMetadataSource !== modifiedMetadataSource) {
				this._metadataEditor = this.instantiationService.createInstance(DiffEditorWidget, this._metadataEditorContainer!, {
					...fixedDiffEditorOptions,
					overflowWidgetsDomNode: this.notebookEditor.getOverflowContainerDomNode()

				});

				DOM.addClass(this._metadataEditorContainer!, 'diff');

				const mode = this.modeService.create('json');
				const originalMetadataModel = this.modelService.createModel(originalMetadataSource, mode, undefined, true);
				const modifiedMetadataModel = this.modelService.createModel(modifiedMetadataSource, mode, undefined, true);
				this._metadataEditor.setModel({
					original: originalMetadataModel,
					modified: modifiedMetadataModel
				});

				this._layoutInfo.metadataHeight = this._metadataEditor.getContentHeight();
				this.layout({ metadataEditor: true });

				this._register(this._metadataEditor.onDidContentSizeChange((e) => {
					if (e.contentHeightChanged && this.cell.metadataFoldingState === PropertyFoldingState.Expanded) {
						this._layoutInfo.metadataHeight = e.contentHeight;
						this.layout({ metadataEditor: true });
					}
				}));

				return;
			}
		}

		this._metadataEditor = this.instantiationService.createInstance(CodeEditorWidget, this._metadataEditorContainer!, {
			...fixedEditorOptions,
			dimension: {
				width: this.cell.getComputedCellContainerWidth(this.notebookEditor.getLayoutInfo(), false, true),
				height: 0
			},
			overflowWidgetsDomNode: this.notebookEditor.getOverflowContainerDomNode()
		}, {});

		const mode = this.modeService.create('json');
		const originalMetadataSource = this._getFormatedMetadataJSON(
			this.cell.type === 'insert'
				? this.cell.modified!.metadata || {}
				: this.cell.original!.metadata || {});
		const metadataModel = this.modelService.createModel(originalMetadataSource, mode, undefined, true);
		this._metadataEditor.setModel(metadataModel);

		this._layoutInfo.metadataHeight = this._metadataEditor.getContentHeight();
		this.layout({ metadataEditor: true });

		this._register(this._metadataEditor.onDidContentSizeChange((e) => {
			if (e.contentHeightChanged && this.cell.metadataFoldingState === PropertyFoldingState.Expanded) {
				this._layoutInfo.metadataHeight = e.contentHeight;
				this.layout({ metadataEditor: true });
			}
		}));
	}

	private _getFormatedOutputJSON(outputs: any[]) {
		const content = JSON.stringify(outputs);

		const edits = format(content, undefined, {});
		const source = applyEdits(content, edits);

		return source;
	}

	private _buildOutputEditor() {
		if (this.cell.type === 'modified' && !this.notebookEditor.textModel!.transientOptions.transientOutputs) {
			const originalOutputsSource = this._getFormatedOutputJSON(this.cell.original?.outputs || []);
			const modifiedOutputsSource = this._getFormatedOutputJSON(this.cell.modified?.outputs || []);
			if (originalOutputsSource !== modifiedOutputsSource) {
				this._outputEditor = this.instantiationService.createInstance(DiffEditorWidget, this._outputEditorContainer!, {
					...fixedDiffEditorOptions,
					overflowWidgetsDomNode: this.notebookEditor.getOverflowContainerDomNode()
				});

				DOM.addClass(this._outputEditorContainer!, 'diff');

				const mode = this.modeService.create('json');
				const originalModel = this.modelService.createModel(originalOutputsSource, mode, undefined, true);
				const modifiedModel = this.modelService.createModel(modifiedOutputsSource, mode, undefined, true);
				this._outputEditor.setModel({
					original: originalModel,
					modified: modifiedModel
				});

				this._layoutInfo.outputHeight = this._outputEditor.getContentHeight();
				this.layout({ outputEditor: true });

				this._register(this._outputEditor.onDidContentSizeChange((e) => {
					if (e.contentHeightChanged && this.cell.outputFoldingState === PropertyFoldingState.Expanded) {
						this._layoutInfo.outputHeight = e.contentHeight;
						this.layout({ outputEditor: true });
					}
				}));

				return;
			}
		}

		this._outputEditor = this.instantiationService.createInstance(CodeEditorWidget, this._outputEditorContainer!, {
			...fixedEditorOptions,
			dimension: {
				width: this.cell.getComputedCellContainerWidth(this.notebookEditor.getLayoutInfo(), false, true),
				height: 0
			},
			overflowWidgetsDomNode: this.notebookEditor.getOverflowContainerDomNode()
		}, {});

		const mode = this.modeService.create('json');
		const originaloutputSource = this._getFormatedOutputJSON(
			this.notebookEditor.textModel!.transientOptions
				? []
				: this.cell.type === 'insert'
					? this.cell.modified!.outputs || []
					: this.cell.original!.outputs || []);
		const outputModel = this.modelService.createModel(originaloutputSource, mode, undefined, true);
		this._outputEditor.setModel(outputModel);

		this._layoutInfo.outputHeight = this._outputEditor.getContentHeight();
		this.layout({ outputEditor: true });

		this._register(this._outputEditor.onDidContentSizeChange((e) => {
			if (e.contentHeightChanged && this.cell.outputFoldingState === PropertyFoldingState.Expanded) {
				this._layoutInfo.outputHeight = e.contentHeight;
				this.layout({ outputEditor: true });
			}
		}));
	}

	protected layoutNotebookCell() {
		this.notebookEditor.layoutNotebookCell(
			this.cell,
			this._layoutInfo.editorHeight
			+ this._layoutInfo.editorMargin
			+ this._layoutInfo.metadataHeight
			+ this._layoutInfo.metadataStatusHeight
			+ this._layoutInfo.outputHeight
			+ this._layoutInfo.outputStatusHeight
			+ this._layoutInfo.bodyMargin
		);
	}

	abstract initData(): void;
	abstract styleContainer(container: HTMLElement): void;
	abstract buildSourceEditor(sourceContainer: HTMLElement): void;
	abstract onDidLayoutChange(event: CellDiffViewModelLayoutChangeEvent): void;
	abstract layout(state: { outerWidth?: boolean, editorHeight?: boolean, metadataEditor?: boolean, outputEditor?: boolean }): void;
}

export class UnchangedCell extends AbstractCellRenderer {
	private _editor!: CodeEditorWidget;

	constructor(
		readonly notebookEditor: INotebookTextDiffEditor,
		readonly cell: CellDiffViewModel,
		readonly templateData: CellDiffRenderTemplate,
		@IModeService readonly modeService: IModeService,
		@IModelService protected modelService: IModelService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
	) {
		super(notebookEditor, cell, templateData, 'full', instantiationService, modeService, modelService);
	}

	initData() {
	}

	styleContainer(container: HTMLElement) {
	}

	buildSourceEditor(sourceContainer: HTMLElement) {
		const editorContainer = DOM.append(sourceContainer, DOM.$('.editor-container'));
		const originalCell = this.cell.original!;
		const lineCount = originalCell.textBuffer.getLineCount();
		const lineHeight = this.notebookEditor.getLayoutInfo().fontInfo.lineHeight || 17;
		const editorHeight = lineCount * lineHeight + EDITOR_TOP_PADDING + EDITOR_BOTTOM_PADDING;

		this._editor = this.instantiationService.createInstance(CodeEditorWidget, editorContainer, {
			...fixedEditorOptions,
			dimension: {
				width: this.notebookEditor.getLayoutInfo().width - 2 * DIFF_CELL_MARGIN,
				height: editorHeight
			},
			overflowWidgetsDomNode: this.notebookEditor.getOverflowContainerDomNode()
		}, {});

		this._register(this._editor.onDidContentSizeChange((e) => {
			if (e.contentHeightChanged) {
				this._layoutInfo.editorHeight = e.contentHeight;
				this.layout({ editorHeight: true });
			}
		}));

		originalCell.resolveTextModelRef().then(ref => {
			this._register(ref);

			const textModel = ref.object.textEditorModel;
			this._editor.setModel(textModel);

			this._layoutInfo.editorHeight = this._editor.getContentHeight();
			this.layout({ editorHeight: true });
		});
	}


	onDidLayoutChange(event: CellDiffViewModelLayoutChangeEvent): void {
		if (event.outerWidth !== undefined) {
			this.layout({ outerWidth: true });
		}
	}

	layout(state: { outerWidth?: boolean, editorHeight?: boolean, metadataEditor?: boolean, outputEditor?: boolean }) {
		if (state.editorHeight || state.outerWidth) {
			this._editor.layout({
				width: this.cell.getComputedCellContainerWidth(this.notebookEditor.getLayoutInfo(), false, true),
				height: this._layoutInfo.editorHeight
			});
		}

		if (state.metadataEditor || state.outerWidth) {
			this._metadataEditor?.layout({
				width: this.cell.getComputedCellContainerWidth(this.notebookEditor.getLayoutInfo(), false, true),
				height: this._layoutInfo.metadataHeight
			});
		}

		if (state.outputEditor || state.outerWidth) {
			this._outputEditor?.layout({
				width: this.cell.getComputedCellContainerWidth(this.notebookEditor.getLayoutInfo(), false, true),
				height: this._layoutInfo.outputHeight
			});
		}

		this.layoutNotebookCell();
	}
}

export class DeletedCell extends AbstractCellRenderer {
	private _editor!: CodeEditorWidget;
	constructor(
		readonly notebookEditor: INotebookTextDiffEditor,
		readonly cell: CellDiffViewModel,
		readonly templateData: CellDiffRenderTemplate,
		@IModeService readonly modeService: IModeService,
		@IModelService readonly modelService: IModelService,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
	) {
		super(notebookEditor, cell, templateData, 'left', instantiationService, modeService, modelService);
	}

	initData(): void {
	}

	styleContainer(container: HTMLElement) {
		DOM.addClass(container, 'removed');
	}

	buildSourceEditor(sourceContainer: HTMLElement): void {
		const originalCell = this.cell.original!;
		const lineCount = originalCell.textBuffer.getLineCount();
		const lineHeight = this.notebookEditor.getLayoutInfo().fontInfo.lineHeight || 17;
		const editorHeight = lineCount * lineHeight + EDITOR_TOP_PADDING + EDITOR_BOTTOM_PADDING;

		const editorContainer = DOM.append(sourceContainer, DOM.$('.editor-container'));

		this._editor = this.instantiationService.createInstance(CodeEditorWidget, editorContainer, {
			...fixedEditorOptions,
			dimension: {
				width: (this.notebookEditor.getLayoutInfo().width - 2 * DIFF_CELL_MARGIN) / 2 - 18,
				height: editorHeight
			},
			overflowWidgetsDomNode: this.notebookEditor.getOverflowContainerDomNode()
		}, {});
		this._layoutInfo.editorHeight = editorHeight;

		this._register(this._editor.onDidContentSizeChange((e) => {
			if (e.contentHeightChanged) {
				this._layoutInfo.editorHeight = e.contentHeight;
				this.layout({ editorHeight: true });
			}
		}));

		originalCell.resolveTextModelRef().then(ref => {
			this._register(ref);

			const textModel = ref.object.textEditorModel;
			this._editor.setModel(textModel);
			this._layoutInfo.editorHeight = this._editor.getContentHeight();
			this.layout({ editorHeight: true });
		});

	}

	onDidLayoutChange(e: CellDiffViewModelLayoutChangeEvent) {
		if (e.outerWidth !== undefined) {
			this.layout({ outerWidth: true });
		}
	}
	layout(state: { outerWidth?: boolean, editorHeight?: boolean, metadataEditor?: boolean, outputEditor?: boolean }) {
		if (state.editorHeight || state.outerWidth) {
			this._editor.layout({
				width: this.cell.getComputedCellContainerWidth(this.notebookEditor.getLayoutInfo(), false, false),
				height: this._layoutInfo.editorHeight
			});
		}

		if (state.metadataEditor || state.outerWidth) {
			this._metadataEditor?.layout({
				width: this.cell.getComputedCellContainerWidth(this.notebookEditor.getLayoutInfo(), false, false),
				height: this._layoutInfo.metadataHeight
			});
		}

		if (state.outputEditor || state.outerWidth) {
			this._outputEditor?.layout({
				width: this.cell.getComputedCellContainerWidth(this.notebookEditor.getLayoutInfo(), false, false),
				height: this._layoutInfo.outputHeight
			});
		}

		this.layoutNotebookCell();
	}
}

export class InsertCell extends AbstractCellRenderer {
	private _editor!: CodeEditorWidget;
	constructor(
		readonly notebookEditor: INotebookTextDiffEditor,
		readonly cell: CellDiffViewModel,
		readonly templateData: CellDiffRenderTemplate,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IModeService readonly modeService: IModeService,
		@IModelService readonly modelService: IModelService,
	) {
		super(notebookEditor, cell, templateData, 'right', instantiationService, modeService, modelService);
	}

	initData(): void {
	}

	styleContainer(container: HTMLElement): void {
		DOM.addClass(container, 'inserted');
	}

	buildSourceEditor(sourceContainer: HTMLElement): void {
		const modifiedCell = this.cell.modified!;
		const lineCount = modifiedCell.textBuffer.getLineCount();
		const lineHeight = this.notebookEditor.getLayoutInfo().fontInfo.lineHeight || 17;
		const editorHeight = lineCount * lineHeight + EDITOR_TOP_PADDING + EDITOR_BOTTOM_PADDING;
		const editorContainer = DOM.append(sourceContainer, DOM.$('.editor-container'));

		this._editor = this.instantiationService.createInstance(CodeEditorWidget, editorContainer, {
			...fixedEditorOptions,
			dimension: {
				width: (this.notebookEditor.getLayoutInfo().width - 2 * DIFF_CELL_MARGIN) / 2 - 18,
				height: editorHeight
			},
			overflowWidgetsDomNode: this.notebookEditor.getOverflowContainerDomNode()
		}, {});

		this._layoutInfo.editorHeight = editorHeight;

		this._register(this._editor.onDidContentSizeChange((e) => {
			if (e.contentHeightChanged) {
				this._layoutInfo.editorHeight = e.contentHeight;
				this.layout({ editorHeight: true });
			}
		}));

		modifiedCell.resolveTextModelRef().then(ref => {
			this._register(ref);

			const textModel = ref.object.textEditorModel;
			this._editor.setModel(textModel);
			this._layoutInfo.editorHeight = this._editor.getContentHeight();
			this.layout({ editorHeight: true });
		});
	}

	onDidLayoutChange(e: CellDiffViewModelLayoutChangeEvent) {
		if (e.outerWidth !== undefined) {
			this.layout({ outerWidth: true });
		}
	}

	layout(state: { outerWidth?: boolean, editorHeight?: boolean, metadataEditor?: boolean, outputEditor?: boolean }) {
		if (state.editorHeight || state.outerWidth) {
			this._editor.layout({
				width: this.cell.getComputedCellContainerWidth(this.notebookEditor.getLayoutInfo(), false, false),
				height: this._layoutInfo.editorHeight
			});
		}

		if (state.metadataEditor || state.outerWidth) {
			this._metadataEditor?.layout({
				width: this.cell.getComputedCellContainerWidth(this.notebookEditor.getLayoutInfo(), false, true),
				height: this._layoutInfo.metadataHeight
			});
		}

		if (state.outputEditor || state.outerWidth) {
			this._outputEditor?.layout({
				width: this.cell.getComputedCellContainerWidth(this.notebookEditor.getLayoutInfo(), false, true),
				height: this._layoutInfo.outputHeight
			});
		}

		this.layoutNotebookCell();
	}
}

export class ModifiedCell extends AbstractCellRenderer {
	private _editor?: DiffEditorWidget;
	private _editorContainer!: HTMLElement;
	constructor(
		readonly notebookEditor: INotebookTextDiffEditor,
		readonly cell: CellDiffViewModel,
		readonly templateData: CellDiffRenderTemplate,
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IModeService readonly modeService: IModeService,
		@IModelService readonly modelService: IModelService,
	) {
		super(notebookEditor, cell, templateData, 'full', instantiationService, modeService, modelService);
	}

	initData(): void {
	}

	styleContainer(container: HTMLElement): void {
	}

	buildSourceEditor(sourceContainer: HTMLElement): void {
		const modifiedCell = this.cell.modified!;
		const lineCount = modifiedCell.textBuffer.getLineCount();
		const lineHeight = this.notebookEditor.getLayoutInfo().fontInfo.lineHeight || 17;
		const editorHeight = lineCount * lineHeight + EDITOR_TOP_PADDING + EDITOR_BOTTOM_PADDING;
		this._editorContainer = DOM.append(sourceContainer, DOM.$('.editor-container'));

		this._editor = this.instantiationService.createInstance(DiffEditorWidget, this._editorContainer, {
			...fixedDiffEditorOptions,
			overflowWidgetsDomNode: this.notebookEditor.getOverflowContainerDomNode()
		});
		DOM.addClass(this._editorContainer, 'diff');

		this._editor.layout({
			width: this.notebookEditor.getLayoutInfo().width - 2 * DIFF_CELL_MARGIN,
			height: editorHeight
		});

		this._editorContainer.style.height = `${editorHeight}px`;

		this._register(this._editor.onDidContentSizeChange((e) => {
			if (e.contentHeightChanged) {
				this._layoutInfo.editorHeight = e.contentHeight;
				this.layout({ editorHeight: true });
			}
		}));

		this._initializeSourceDiffEditor();
	}

	private async _initializeSourceDiffEditor() {
		const originalCell = this.cell.original!;
		const modifiedCell = this.cell.modified!;

		const originalRef = await originalCell.resolveTextModelRef();
		const modifiedRef = await modifiedCell.resolveTextModelRef();
		const textModel = originalRef.object.textEditorModel;
		const modifiedTextModel = modifiedRef.object.textEditorModel;
		this._register(originalRef);
		this._register(modifiedRef);

		this._editor!.setModel({
			original: textModel,
			modified: modifiedTextModel
		});

		const contentHeight = this._editor!.getContentHeight();
		this._layoutInfo.editorHeight = contentHeight;
		this.layout({ editorHeight: true });

	}

	onDidLayoutChange(e: CellDiffViewModelLayoutChangeEvent) {
		if (e.outerWidth !== undefined) {
			this.layout({ outerWidth: true });
		}
	}

	layout(state: { outerWidth?: boolean, editorHeight?: boolean, metadataEditor?: boolean, outputEditor?: boolean }) {
		if (state.editorHeight || state.outerWidth) {
			this._editorContainer.style.height = `${this._layoutInfo.editorHeight}px`;
			this._editor!.layout();
		}

		if (state.metadataEditor || state.outerWidth) {
			if (this._metadataEditorContainer) {
				this._metadataEditorContainer.style.height = `${this._layoutInfo.metadataHeight}px`;
				this._metadataEditor?.layout();
			}
		}

		if (state.outputEditor || state.outerWidth) {
			if (this._outputEditorContainer) {
				this._outputEditorContainer.style.height = `${this._layoutInfo.outputHeight}px`;
				this._outputEditor?.layout();
			}
		}

		this.layoutNotebookCell();
	}
}
