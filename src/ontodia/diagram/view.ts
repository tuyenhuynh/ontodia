import { hcl } from 'd3-color';
import * as Backbone from 'backbone';
import * as joint from 'jointjs';
import { merge, cloneDeep, each } from 'lodash';
import { createElement } from 'react';
import { render as reactDOMRender, unmountComponentAtNode } from 'react-dom';

import {
    TypeStyleResolver,
    LinkStyleResolver,
    TemplateResolver,
    CustomTypeStyle,
    ElementTemplate,
    LinkStyle, LinkMarkerStyle,
} from '../customization/props';
import { DefaultTypeStyleBundle } from '../customization/defaultTypeStyles';
import { DefaultLinkStyleBundle } from '../customization/defaultLinkStyles';
import { DefaultTemplate } from '../customization/defaultTemplate';
import { DefaultTemplateBundle } from '../customization/templates/defaultTemplates';

import { Halo } from '../viewUtils/halo';
import { ConnectionsMenu } from '../viewUtils/connectionsMenu';
import { IsAPathMenu } from '../viewUtils/isAPathMenu';

import {
    toSVG, ToSVGOptions, toDataURL, ToDataURLOptions,
} from '../viewUtils/toSvg';

import { Dictionary, ElementModel, LocalizedString, ConceptModel } from '../data/model';

import { DiagramModel, chooseLocalizedText, uri2name, HAS_RELATION_WITH_IRI, SUB_CLASS_OF_IRI } from './model';
import { Element, FatClassModel, linkMarkerKey , Link} from './elements';

import { LinkView } from './linkView';
import { SeparatedElementView } from './separatedElementView';
import { ElementLayer } from './elementLayer';
import union = require("lodash/union");

export interface DiagramViewOptions {
    typeStyleResolvers?: TypeStyleResolver[];
    linkStyleResolvers?: LinkStyleResolver[];
    templatesResolvers?: TemplateResolver[];
    disableDefaultHalo?: boolean;
}

export interface TypeStyle {
    color: { h: number; c: number; l: number; };
    icon?: string;
}

/**
 * Properties:
 *     language: string
 * 
 * Events:
 *     (private) dispose - fires on view dispose
 */
export class DiagramView extends Backbone.Model {
    private typeStyleResolvers: TypeStyleResolver[];
    private linkStyleResolvers: LinkStyleResolver[];
    private templatesResolvers: TemplateResolver[];

    paper: joint.dia.Paper;
    connectionsMenu: ConnectionsMenu;
    isAPathMenu: IsAPathMenu;

    private recentlyExtractedElements: Element[];
    private visualizedConcepts: ConceptModel[] = [];

    readonly selection = new Backbone.Collection<Element>();

    private colorSeed = 0x0BADBEEF;

    private toSVGOptions: ToSVGOptions = {
        elementsToRemoveSelector: '.link-tools, .marker-vertices',
        convertImagesToDataUris: true,
    };

    private linkMarkers: Dictionary<{
        start: SVGMarkerElement;
        end: SVGMarkerElement;
    }> = {};

    constructor(
        public readonly model: DiagramModel,
        public readonly options: DiagramViewOptions = {}
    ) {
        super();
        this.setLanguage('en');
        this.paper = new joint.dia.Paper({
            model: this.model.graph,
            gridSize: 1,
            elementView: SeparatedElementView,
            linkView: LinkView,
            width: 1500,
            height: 800,
            async: true,
            preventContextMenu: false,
            guard: (evt, view) => {
                // filter right mouse button clicks
                if (evt.type === 'mousedown' && evt.button !== 0) { return true; }
                return false;
            },
        });
        (this.paper as any).diagramView = this;

        this.typeStyleResolvers = options.typeStyleResolvers
            ? options.typeStyleResolvers : DefaultTypeStyleBundle;

        this.linkStyleResolvers = options.linkStyleResolvers
            ? this.options.linkStyleResolvers : DefaultLinkStyleBundle;

        this.templatesResolvers = options.templatesResolvers
            ? options.templatesResolvers : DefaultTemplateBundle;

        this.listenTo(this.paper, 'render:done', () => {
            this.model.trigger('state:renderDone');
        });

        this.listenTo(this.model, 'state:dataLoaded', () => {
            this.model.resetHistory();
        });
    }

    public clearPaper() {
        this.model.graph.trigger('batch:start');
        let elements = this.model.elements;
        for (const element of elements) {
            element.remove();
        }
        this.selection.reset([]);
        this.model.graph.trigger('batch:stop');
        this.model.unShowConcepts();
    }

    visualizeKeyConcepts(conceptCount: number) {
        this.clearPaper();
        let keyConcepts: ConceptModel[] = this.model.extractKeyConcepts(conceptCount);
        this.model.initBatchCommand();
        let elementsToSelect: Element[] = [];

        let totalXOffset = 0;
        let x = 300, y = 300;

        // This will fix element selection error
        setTimeout(() => {
            each(keyConcepts, el => {
                const element = this.createElementAt(el.id, {x: x, y: y, center:false});
                x += element.get('size').width;
                if(x >800) {
                    totalXOffset = 0;
                    x = 300;
                    y += element.get('size').height + 50;
                }
                elementsToSelect.push(element);
                el.presentOnDiagram = true;
            });

            this.visualizedConcepts = keyConcepts;
            this.model.requestElementData(elementsToSelect);
            this.model.createVirtualLinksBetweenVisualizedConcepts(this.visualizedConcepts);
            this.model.requestLinksOfType();
            this.selection.reset(elementsToSelect);
            this.model.storeBatchCommand();
        }, 100);
    }

    getLanguage(): string { return this.get('language'); }
    setLanguage(value: string) { this.set('language', value); }

    cancelSelection() { this.selection.reset([]); }

    print() {
        this.exportSVG().then(svg => {
            const printWindow = window.open('', undefined, 'width=1280,height=720');
            printWindow.document.write(svg);
            printWindow.print();
        });
    }

    exportSVG(): Promise<string> {
        return toSVG(this.paper, this.toSVGOptions);
    }

    exportPNG(options: ToDataURLOptions = {}): Promise<string> {
        options.svgOptions = options.svgOptions || this.toSVGOptions;
        return toDataURL(this.paper, options);
    }

    adjustPaper() {
        this.paper.trigger('ontodia:adjustSize');
    }

    initializePaperComponents() {
        this.configureElementLayer();
        if (!this.model.isViewOnly()) {
            this.configureSelection();
            this.configureDefaultHalo();
            document.addEventListener('keyup', this.onKeyUp);
            this.onDispose(() => document.removeEventListener('keyup', this.onKeyUp));
        }
    }

    // A layer on paper-area layer
    private configureElementLayer() {
        const container = document.createElement('div');
        this.paper.el.appendChild(container);
        reactDOMRender(createElement(ElementLayer, {paper: this.paper, view: this}), container);
        this.onDispose(() => {
            unmountComponentAtNode(container);
            this.paper.el.removeChild(container);
        });
    }

    private onKeyUp = (e: KeyboardEvent) => {
        const DELETE_KEY_CODE = 46;
        if (e.keyCode === DELETE_KEY_CODE &&
            document.activeElement.localName !== 'input'
        ) {
            this.removeSelectedElements();
        }
    };

    private removeSelectedElements() {
        const elementsToRemove = this.selection.toArray();
        if (elementsToRemove.length === 0) { return; }

        this.cancelSelection();
        this.model.graph.trigger('batch:start');
        for (const element of elementsToRemove) {
            element.remove();
        }
        this.model.graph.trigger('batch:stop');
    };

    private configureSelection() {
        if (this.model.isViewOnly()) { return; }

        this.listenTo(this.paper, 'cell:pointerup', (cellView: joint.dia.CellView, evt: MouseEvent) => {
            // We don't want a Halo for links.
            if (cellView.model instanceof joint.dia.Link) {
                return;
            }
            if (evt.ctrlKey || evt.shiftKey || evt.metaKey) { return; }
            const element = cellView.model as Element;
            this.selection.reset([element]);
            element.focus();
        });

        this.listenTo(this.paper, 'cell:mouseover', (cellView: joint.dia.CellView, evt: MouseEvent) => {
            if(!this.isAPathMenu) {
                if (cellView.model instanceof joint.dia.Link) {
                    let link : Link = cellView.model as Link;
                    let shouldShow = (link.typeId === SUB_CLASS_OF_IRI
                        || link.typeId === HAS_RELATION_WITH_IRI)
                        && !link.directLink;
                    if(shouldShow) {
                        this.showIsAPath(cellView);
                    }
                }
            }
        });

        this.listenTo(this.paper, 'cell:mouseout', (cellView: joint.dia.CellView, evt: MouseEvent) => {
            if (cellView.model instanceof joint.dia.Link) {
                let link : Link = cellView.model as Link;
                let shouldRemove = (link.typeId === SUB_CLASS_OF_IRI ||
                link.typeId === HAS_RELATION_WITH_IRI) && this.isAPathMenu;
                if(shouldRemove) {
                    this.isAPathMenu.remove();
                    this.isAPathMenu = undefined;
                }
            }
        });

        let pointerScreenCoords = {x: NaN, y: NaN};
        this.listenTo(this.paper, 'blank:pointerdown', (evt: MouseEvent) => {
            pointerScreenCoords = {x: evt.screenX, y: evt.screenY};
        });

        this.listenTo(this.paper, 'blank:pointerup', (evt: MouseEvent) => {
            if (evt.screenX !== pointerScreenCoords.x || evt.screenY !== pointerScreenCoords.y) { return; }
            this.selection.reset();
            this.hideNavigationMenu();
            if (document.activeElement) {
                (document.activeElement as HTMLElement).blur();
            }
        });
    }

    private configureDefaultHalo() {
        if (this.options.disableDefaultHalo) { return; }

        const container = document.createElement('div');
        this.paper.el.appendChild(container);
        const renderDefaultHalo = (selectedElement?: Element) => {
            let cellView: joint.dia.CellView = undefined;
            if (selectedElement) {
                cellView = this.paper.findViewByModel(selectedElement);
            }
            reactDOMRender(createElement(Halo, {
                paper: this.paper,
                diagramView: this,
                cellView: cellView,
                onDelete: () => this.removeSelectedElements(),
                onExpand: () => {
                    cellView.model.set('isExpanded', !cellView.model.get('isExpanded'));
                },
                navigationMenuOpened: Boolean(this.connectionsMenu),
                onToggleNavigationMenu: () => {
                    if (this.connectionsMenu) {
                        this.hideNavigationMenu();
                    } else {
                        this.showNavigationMenu(selectedElement);
                    }
                    renderDefaultHalo(selectedElement);
                },
                onAddToFilter: () => selectedElement.addToFilter(),
                onLoadMoreConcepts: () => {
                    this.loadMoreConcepts(selectedElement);
                },
                isVisualizationMode: true,
            }), container);
        };

        this.listenTo(this.selection, 'add remove reset', () => {
            const selected = this.selection.length === 1 ? this.selection.first() : undefined;
            if (this.connectionsMenu && selected !== this.connectionsMenu.cellView.model) {
                this.hideNavigationMenu();
            }
            renderDefaultHalo(selected);
        });

        renderDefaultHalo();
        this.onDispose(() => {
            unmountComponentAtNode(container);
            this.paper.el.removeChild(container);
        });
    }

    private selectedElement:Element;
    private addedConceptsList: ConceptModel[][] = [];

    loadMoreConcepts(selectedElement: Element) {
        this.selectedElement = selectedElement;

        let concepts: ConceptModel[] = this.model.loadMoreConcepts(selectedElement.id);

        const positionBoxSide = Math.round(Math.sqrt(concepts.length)) + 1;
        const GRID_STEP = 100;
        let pos;
        let cellView = this.paper.findViewByModel(selectedElement);

        if (cellView.model instanceof joint.dia.Element) {
            pos = cellView.model.position();
        } else {
            pos = cellView.getBBox();
        }
        const startX = pos.x - positionBoxSide * GRID_STEP / 2;
        const startY = pos.y - positionBoxSide * GRID_STEP / 2;
        let xi = 0;
        let yi = 0;

        const addedElements: Element[] = [];
        this.model.initBatchCommand();

        concepts.forEach(el => {
            if (xi > positionBoxSide) {
                xi = 0;
                yi++;
            }
            if (xi === Math.round(positionBoxSide / 2)) {
                xi++;
            }
            if (yi === Math.round(positionBoxSide / 2)) {
                yi++;
            }

            const element = this.createElementAt(el.id, {x: startX + (xi++) * GRID_STEP, y: startY + (yi) * GRID_STEP});
            element.set('recentlyExtracted', true);
            el.presentOnDiagram = true;
            addedElements.push(element);
        });

        if(addedElements.length > 0) {
            each(this.recentlyExtractedElements, el => {
                el.set('recentlyExtracted', false);
            });
            this.recentlyExtractedElements = addedElements;
            this.addedConceptsList.push(concepts);
        }

        this.model.removeVirtualLinks();
        this.visualizedConcepts = union(this.visualizedConcepts, concepts);
        this.model.requestElementData(addedElements);
        this.model.createVirtualLinksBetweenVisualizedConcepts(this.visualizedConcepts);
        this.model.requestLinksOfType();
        this.model.storeBatchCommand();
    }

    previousKCEView() {
        if(this.addedConceptsList.length > 0) {
            let lastAddedConcepts = this.addedConceptsList.pop();
            each(lastAddedConcepts, concept => {
                let element = this.model.getElement(concept.id);
                if(element) {
                    element.remove();
                }
                concept.presentOnDiagram = false;
            });
            this.model.removeVirtualLinks();
            this.visualizedConcepts.splice(-1, lastAddedConcepts.length);
            this.model.createVirtualLinksBetweenVisualizedConcepts(this.visualizedConcepts);
            this.model.requestLinksOfType();
        }
    }

    showNavigationMenu(element: Element) {
        const cellView = this.paper.findViewByModel(element);
        this.connectionsMenu = new ConnectionsMenu({
            paper: this.paper,
            view: this,
            cellView,
            onClose: () => {
                this.connectionsMenu.remove();
                this.connectionsMenu = undefined;
            },
        });
    }

    showIsAPath(cellView: joint.dia.CellView) {
        this.isAPathMenu = new IsAPathMenu({
            paper: this.paper,
            view: this,
            cellView,
            onClose: () => {
                this.isAPathMenu.remove();
                this.isAPathMenu = undefined;
            },
        });
    }

    hideNavigationMenu() {
        if (this.connectionsMenu) {
            this.connectionsMenu.remove();
            this.connectionsMenu = undefined;
        }

        if(this.isAPathMenu) {
            this.isAPathMenu.remove();
            this.isAPathMenu = undefined;
        }
    }

    onDragDrop(e: DragEvent, paperPosition: { x: number; y: number; }) {
        e.preventDefault();
        let elementIds: string[];
        try {
            // Elements dragged from filter panel
            elementIds = JSON.parse(e.dataTransfer.getData('application/x-ontodia-elements'));
        } catch (ex) {
            try {
                elementIds = JSON.parse(e.dataTransfer.getData('text')); // IE fix
            } catch (ex) {
                // Elements dragged from the class panel (Single element)
                const draggedUri = e.dataTransfer.getData('text/uri-list');
                // element dragged from the class tree has URI of the form:
                // <window.location without hash>#<class URI>
                const uriFromTreePrefix = window.location.href.split('#')[0] + '#';
                const uri = draggedUri.indexOf(uriFromTreePrefix) === 0
                    ? draggedUri.substring(uriFromTreePrefix.length) : draggedUri;
                elementIds = [uri];
            }
        }
        if (!elementIds || elementIds.length === 0) { return; }

        this.model.initBatchCommand();

        let elementsToSelect: Element[] = [];

        let totalXOffset = 0;
        let {x, y} = paperPosition;
        for (const elementId of elementIds) {
            const center = elementIds.length === 1;
            const element = this.createElementAt(elementId, {x: x + totalXOffset, y, center});
            totalXOffset += element.get('size').width + 20;
            elementsToSelect.push(element);
            element.focus();
        }

        this.model.requestElementData(elementsToSelect);
        this.model.requestLinksOfType();
        this.selection.reset(elementsToSelect);

        this.model.storeBatchCommand();
    }

    //Create element from given id. Add element to model if element does not exist in model.
    public createElementAt(elementId: string, position: { x: number; y: number; center?: boolean; }) {
        const element = this.model.createElement(elementId);
        let {x, y} = position;
        const size: { width: number; height: number; } = element.get('size');
        if (position.center) {
            x -= size.width / 2;
            y -= size.height / 2;
        }
        element.set('position', {x, y});

        return element;
    }

    /**
     * Get subclass info of element
     *
     * @param elementId
     * Return string, representing number of direct sub classes and indirect subclasses of of class or empty string if element is not a class
     */
    public getSubClassInfo(elementId: string) : string{
        return this.model.getSubConceptInfo(elementId);
    }

    public getLocalizedText(texts: LocalizedString[]): LocalizedString {
        return chooseLocalizedText(texts, this.getLanguage());
    }

    public getElementTypeString(elementModel: ElementModel): string {
        return elementModel.types.map((typeId: string) => {
            const type = this.model.getClassesById(typeId);
            return this.getElementTypeLabel(type).text;
        }).sort().join(', ');
    }

    public getElementTypeLabel(type: FatClassModel): LocalizedString {
        const label = this.getLocalizedText(type.get('label').values);
        return label ? label : { text: uri2name(type.id), lang: '' };
    }

    public getLinkLabel(linkTypeId: string): LocalizedString {
        const type = this.model.getLinkType(linkTypeId);
        const label = type ? this.getLocalizedText(type.get('label').values) : null;
        return label ? label : { text: uri2name(linkTypeId), lang: '' };
    }

    /**
     * @param types Type signature, MUST BE sorted; see DiagramModel.normalizeData()
     */
    public getTypeStyle(id: string, types: string[], recentlyExtracted?: boolean): TypeStyle {
        types.sort();
        let customStyle: CustomTypeStyle;
        for (const resolver of this.typeStyleResolvers) {
            const result = resolver(id, types, recentlyExtracted);
            if (result) {
                customStyle = result;
                break;
            }
        }

        const icon = customStyle ? customStyle.icon : undefined;
        let color: { h: number; c: number; l: number; };
        if (customStyle && customStyle.color) {
            color = hcl(customStyle.color);
        } else {
            const hue = getHueFromClasses(types, this.colorSeed);
            color = {h: hue + 30, c: 100, l: 55};
        }
        return {icon, color};
    }

    public registerElementStyleResolver(resolver: TypeStyleResolver): TypeStyleResolver {
        this.typeStyleResolvers.unshift(resolver);
        return resolver;
    }

    public unregisterElementStyleResolver(resolver: TypeStyleResolver): TypeStyleResolver {
        const index = this.typeStyleResolvers.indexOf(resolver);
        if (index !== -1) {
            return this.typeStyleResolvers.splice(index, 1)[0];
        } else {
            return undefined;
        }
    }

    public getElementTemplate(id: string, types: string[]): ElementTemplate {
        for (const resolver of this.templatesResolvers) {
            const result = resolver(id, types);
            if (result) {
                return result;
            }
        }
        return DefaultTemplate;
    }

    public registerTemplateResolver(resolver: TemplateResolver): TemplateResolver {
        this.templatesResolvers.unshift(resolver);
        return resolver;
    }

    public unregisterTemplateResolver(resolver: TemplateResolver): TemplateResolver {
        const index = this.templatesResolvers.indexOf(resolver);
        if (index !== -1) {
            return this.templatesResolvers.splice(index, 1)[0];
        } else {
            return undefined;
        }
    }

    getLinkStyle(linkTypeId: string, directLink: boolean): LinkStyle {
        let style = getDefaultLinkStyle();
        for (const resolver of this.linkStyleResolvers) {
            const result = resolver(linkTypeId, directLink);
            if (result) {
                merge(style, cloneDeep(result));
                break;
            }
        }
        if (!this.linkMarkers[linkTypeId]) {
            this.linkMarkers[linkTypeId] = {
                start: this.createLinkMarker(linkTypeId, true, style.markerSource),
                end: this.createLinkMarker(linkTypeId, false, style.markerTarget),
            };
        }
        return style;
    }

    private createLinkMarker(linkTypeId: string, startMarker: boolean, style: LinkMarkerStyle) {
        if (!style) { return undefined; }

        const SVG_NAMESPACE: 'http://www.w3.org/2000/svg' = 'http://www.w3.org/2000/svg';
        const defs = this.paper.svg.getElementsByTagNameNS(SVG_NAMESPACE, 'defs')[0];
        const marker = document.createElementNS(SVG_NAMESPACE, 'marker');
        const linkTypeIndex = this.model.getLinkType(linkTypeId).index;
        marker.setAttribute('id', linkMarkerKey(linkTypeIndex, startMarker));
        marker.setAttribute('markerWidth', style.width.toString());
        marker.setAttribute('markerHeight', style.height.toString());
        marker.setAttribute('orient', 'auto');

        let xOffset = startMarker ? 0 : (style.width - 1);
        marker.setAttribute('refX', xOffset.toString());
        marker.setAttribute('refY', (style.height / 2).toString());
        marker.setAttribute('markerUnits', 'userSpaceOnUse');

        const path = document.createElementNS(SVG_NAMESPACE, 'path');
        path.setAttribute('d', style.d);
        if (style.fill !== undefined) { path.setAttribute('fill', style.fill); }
        if (style.stroke !== undefined) { path.setAttribute('stroke', style.stroke); }
        if (style.strokeWidth !== undefined) { path.setAttribute('stroke-width', style.strokeWidth); }

        marker.appendChild(path);
        defs.appendChild(marker);
        return marker;
    }

    public registerLinkStyleResolver(resolver: LinkStyleResolver): LinkStyleResolver {
        this.linkStyleResolvers.unshift(resolver);
        return resolver;
    }

    public unregisterLinkStyleResolver(resolver: LinkStyleResolver): LinkStyleResolver {
        const index = this.linkStyleResolvers.indexOf(resolver);
        if (index !== -1) {
            return this.linkStyleResolvers.splice(index, 1)[0];
        } else {
            return undefined;
        }
    }

    public getOptions(): DiagramViewOptions {
        return this.options;
    }

    private onDispose(handler: () => void) {
        this.listenTo(this, 'dispose', handler);
    }

    dispose() {
        if (!this.paper) { return; }
        this.trigger('dispose');
        this.stopListening();
        this.paper.remove();
        this.paper = undefined;
    }
}

function getHueFromClasses(classes: string[], seed?: number): number {
    let hash = seed;
    for (const name of classes) {
        hash = hashFnv32a(name, hash);
    }
    const MAX_INT32 = 0x7fffffff;
    return 360 * ((hash === undefined ? 0 : hash) / MAX_INT32);
}

function getDefaultLinkStyle(): LinkStyle {
    let result = {
        markerTarget: {d: 'M0,0 L0,8 L9,4 z', width: 9, height: 8, fill: 'black'},
    };
    return result;
}

/**
 * Calculate a 32 bit FNV-1a hash
 * Found here: https://gist.github.com/vaiorabbit/5657561
 * Ref.: http://isthe.com/chongo/tech/comp/fnv/
 *
 * @param {string} str the input value
 * @param {boolean} [asString=false] set to true to return the hash value as
 *     8-digit hex string instead of an integer
 * @param {integer} [seed] optionally pass the hash of the previous chunk
 * @returns {integer | string}
 */
function hashFnv32a(str: string, seed = 0x811c9dc5): number {
    /* tslint:disable:no-bitwise */
    let i: number, l: number, hval = seed & 0x7fffffff;

    for (i = 0, l = str.length; i < l; i++) {
        hval ^= str.charCodeAt(i);
        hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8) + (hval << 24);
    }
    return hval >>> 0;
    /* tslint:enable:no-bitwise */
}

export default DiagramView;
