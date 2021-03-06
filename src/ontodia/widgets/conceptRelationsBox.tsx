import * as React from 'react';
import * as Backbone from 'backbone';

import { Dictionary, ElementModel} from '../data/model';

import { ListElementView } from './listElementView';
import {DiagramView} from "../diagram/view";

export interface ConceptRelationsBoxProps {
    view: DiagramView;
    title: string;
    onDragDrop: (e: DragEvent) => void;
    onDragOver?: (e: DragEvent) => boolean;
    id: string;
    items: ElementModel[];
}

export interface State {
    items: Array<ElementModel>;
    selectedItems?: Dictionary<boolean>;
}

const CLASS_NAME = 'kce-concept-relations-box';

export class ConceptRelationsBox extends React.Component<ConceptRelationsBoxProps, State> {
    private readonly listener = new Backbone.Model();

    constructor(props: ConceptRelationsBoxProps) {
        super(props);
        this.state = {
            items: props.items,
            selectedItems: {},
        };
    }

    // e is recognized as DragEvent<HTMLDivElement>
    private onDragDrop = (e: Object) => {
        if (this.props.onDragDrop) {
            this.props.onDragDrop(e as DragEvent);
        }
    };

    render() {
        const className = `${CLASS_NAME}`;
        return(
            <div className={className} onDrop={this.onDragDrop}>
                <div className={`${CLASS_NAME}__title`}>{this.props.title}</div>
                <div className={`${CLASS_NAME}__rest`}>
                    {this.renderElements()}
                </div>
            </div>
        );
    }

    private renderElements(): React.ReactElement<any> {
        const items = this.state.items || [];
        return <ul className={`${CLASS_NAME}__results`}>
            {items.map((model, index) => <ListElementView key={index}
                model={model}
                view={this.props.view}
                disabled={Boolean(this.props.view.model.getElement(model.id))}
                selected={this.state.selectedItems[model.id] || false}
                onClick={() => this.setState({
                    selectedItems: {
                        ...this.state.selectedItems,
                        [model.id]: !this.state.selectedItems[model.id],
                    },
                    items: this.state.items,
                })}
                onDragStart={e => {
                    const elementIds = Object.keys({...this.state.selectedItems, [model.id]: true});
                    try {
                        e.dataTransfer.setData('application/x-ontodia-elements', JSON.stringify({source: this.props.id, elementIds: elementIds }));
                    } catch (ex) { // IE fix
                        e.dataTransfer.setData('text', JSON.stringify({source: this.props.id, elementIds: elementIds }));
                    }
                    return false;
                }} />,
            )}
        </ul>;
    }

    componentDidMount() {
        this.listener.listenTo(this.props.view, 'change:language', () => this.forceUpdate());
        this.listener.listenTo(this.props.view.model.cells, 'add remove reset', () => {
            const selectedItems: Dictionary<boolean> = {...this.state.selectedItems};
            for (const id of Object.keys(selectedItems)) {
                if (selectedItems[id] && this.props.view.model.getElement(id)) {
                    delete selectedItems[id];
                }
            }
            this.setState({selectedItems, items: this.state.items});
        });
    }

    componentWillUnmount() {
        this.listener.stopListening();
    }
}
