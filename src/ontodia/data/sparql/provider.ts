import * as $ from 'jquery';

import { DataProvider, FilterParams } from '../provider';
import {
    Dictionary, ClassModel, LinkType, ElementModel, LinkModel, LinkCount, PropertyModel, PropertyCount,
    ConceptModel
} from '../model';
import {
    getClassTree,
    getClassInfo,
    getLinkTypes,
    getElementsInfo,
    getLinksInfo,
    getLinksTypesOf,
    getFilteredData,
    getEnrichedElementsInfo,
    getLinkTypesInfo,
    getPropertyInfo,
    getPropertyCountOfConcepts,
    getInstanceConceptsTree,
} from './responseHandler';
import {
    SparqlResponse, ClassBinding, ElementBinding, LinkBinding,
    LinkTypeBinding, LinkTypeInfoBinding, ElementImageBinding,
    PropertyBinding, PropertyCountBinding, ConceptBinding,
} from './sparqlModels';
import Config from './stardogConfig';

const DEFAULT_PREFIX =
`PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
 PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
 PREFIX owl:  <http://www.w3.org/2002/07/owl#>
` + '\n\n';

export interface SparqlDataProviderOptions {
    endpointUrl: string;
    prepareImages?: (elementInfo: Dictionary<ElementModel>) => Promise<Dictionary<string>>;
    imageClassUris?: string[];
}

export class SparqlDataProvider implements DataProvider {
    constructor(private options: SparqlDataProviderOptions) {}

    classTree(): Promise<[ClassModel[], ConceptModel]> {
        const query = DEFAULT_PREFIX + `
            SELECT ?class ?instcount ?label ?parent
            WHERE {
                {{
                    SELECT ?class (count(?inst) as ?instcount)
                    WHERE {
                        ?inst a ?class.
                    }
                    GROUP BY ?class
                }} UNION {
                    ?class a owl:Class
                }
                OPTIONAL { ?class rdfs:label ?label.}
                OPTIONAL {?class rdfs:subClassOf ?parent}
            }
        `;
        return executeSparqlQuery<ClassBinding>(
            this.options.endpointUrl, query).then(getClassTree);
    }

    instanceConceptsTree(classifierIds: string[], inverseClassifierIds: string[]): Promise<ConceptModel> {
        const classifiers = classifierIds.map(escapeIri).join(', ');
        const inverseClassifiers = inverseClassifierIds.map(escapeIri).join(', ');
        const query = DEFAULT_PREFIX + `
            SELECT ?concept ?label ?child ?childLabel ?parent ?parentLabel
            WHERE {
              {
                ?concept rdf:type ?type.
                ?type a owl:Class
              }
              OPTIONAL {
                ?concept rdfs:label ?label.
              }
              OPTIONAL {
                ?concept ?reverseClassifierRel ?child.
                ?child a owl:NamedIndividual.
                filter(?reverseClassifierRel in (${inverseClassifiers})).
                OPTIONAL {
                  ?child rdfs:label ?childLabel
                }
              }
              OPTIONAL {
                ?concept ?directClassifierRel ?parent.
                ?parent a owl:NamedIndividual.
                filter(?directClassifierRel in (${classifiers})).
                OPTIONAL {
                  ?parent rdfs:label ?parentLabel
                }
              }
            }
        `;
        return executeSparqlQuery<ConceptBinding> (this.options.endpointUrl, query).then(getInstanceConceptsTree);
    }

    propertyInfo(params: { propertyIds: string[] }): Promise<Dictionary<PropertyModel>> {
        const ids = params.propertyIds.map(escapeIri).map(id => ` ( ${id} )`).join(' ');
        const query = DEFAULT_PREFIX + `
            SELECT ?prop ?label
            WHERE {
                ?prop rdfs:label ?label.
                VALUES (?prop) {${ids}}.
            }
        `;
        return executeSparqlQuery<PropertyBinding>(
            this.options.endpointUrl, query).then(getPropertyInfo);
    }

    classInfo(params: {classIds: string[]}): Promise<ClassModel[]> {
        const ids = params.classIds.map(escapeIri).map(id => ` ( ${id} )`).join(' ');
        const query = DEFAULT_PREFIX + `
            SELECT ?class ?label ?instcount
            WHERE {
                ?class rdfs:label ?label.
                VALUES (?class) {${ids}}.
                BIND("" as ?instcount)
            }
        `;
        return executeSparqlQuery<ClassBinding>(
            this.options.endpointUrl, query).then(getClassInfo);
    }

    linkTypesInfo(params: {linkTypeIds: string[]}): Promise<LinkType[]> {
        const ids = params.linkTypeIds.map(escapeIri).map(id => ` ( ${id} )`).join(' ');
        const query = DEFAULT_PREFIX + `
            SELECT ?type ?label ?instcount
            WHERE {
                ?type rdfs:label ?label.
                VALUES (?type) {${ids}}.
                BIND("" as ?instcount)      
            }
        `;
        return executeSparqlQuery<LinkTypeInfoBinding>(
            this.options.endpointUrl, query).then(getLinkTypesInfo);
    }

    linkTypes(): Promise<LinkType[]> {
        const query = DEFAULT_PREFIX + `
            SELECT ?link ?instcount ?label
            WHERE {
                {{
                    SELECT ?link (count(?link) as ?instcount)
                    WHERE {
                        [] ?link ?obj.
                        filter (IsIRI(?obj))
                    }
                    GROUP BY ?link
                }} UNION {
                    ?link a owl:ObjectProperty
                }
                OPTIONAL {?link rdfs:label ?label}
            }
        `;
        return executeSparqlQuery<LinkTypeBinding>(
            this.options.endpointUrl, query).then(getLinkTypes);
    }

    elementInfo(params: { elementIds: string[]; }): Promise<Dictionary<ElementModel>> {
        const ids: string = params.elementIds.map(escapeIri).join(', ');
        const query = DEFAULT_PREFIX + `
            SELECT ?inst ?class ?label ?propType ?propValue
            WHERE {{
                FILTER (?inst IN (${ids}))
                OPTIONAL {?inst rdf:type ?class . }
                OPTIONAL {?inst rdfs:label ?label}
            } UNION {
                FILTER (?inst IN (${ids}))
                OPTIONAL {?inst ?propType ?propValue.
                FILTER (isLiteral(?propValue)) }
            }}
        `;
        return executeSparqlQuery<ElementBinding>(this.options.endpointUrl, query)
            .then(elementsInfo => getElementsInfo(elementsInfo, params.elementIds))
            .then(elementsInfo => {
                if (this.options.prepareImages) {
                    return this.prepareElementsImage(elementsInfo);
                } else if (this.options.imageClassUris && this.options.imageClassUris.length) {
                    return this.enrichedElementsInfo(elementsInfo, this.options.imageClassUris);
                } else {
                    return elementsInfo;
                }
            });
    }

    private enrichedElementsInfo(
        elementsInfo: Dictionary<ElementModel>,
        types: string[]
    ): Promise<Dictionary<ElementModel>> {
        const ids = Object.keys(elementsInfo).map(escapeIri).join(', ');
        const typesString = types.map(escapeIri).join(', ');

        const query = DEFAULT_PREFIX + `
            SELECT ?inst ?linkType ?image
            WHERE {{
                FILTER (?inst IN (${ids}))
                FILTER (?linkType IN (${typesString}))
                ?inst ?linkType ?image
            }}
        `;
        return executeSparqlQuery<ElementImageBinding>(this.options.endpointUrl, query)
            .then(imageResponce => getEnrichedElementsInfo(imageResponce, elementsInfo)).catch((err) => {
                console.log(err);
                return elementsInfo;
            });
    }

    private prepareElementsImage(
        elementsInfo: Dictionary<ElementModel>
    ): Promise<Dictionary<ElementModel>> {
        return this.options.prepareImages(elementsInfo).then(images => {
            for (const key in images) {
                if (images.hasOwnProperty(key) && elementsInfo[key]) {
                    elementsInfo[key].image = images[key];
                }
            }
            return elementsInfo;
        });
    }

    linksInfo(params: {
        elementIds: string[];
        linkTypeIds: string[];
    }): Promise<LinkModel[]> {
        // Get links between objects on papers
        const ids = params.elementIds.map(escapeIri).join(', ');
        const types = params.linkTypeIds.map(escapeIri).join(', ');
        const query = DEFAULT_PREFIX + `
            SELECT ?source ?type ?target
            WHERE {
                ?source ?type ?target.
                FILTER (?source in (${ids}))
                FILTER (?target in (${ids}))
                FILTER (?type in (${types}))
            }
        `;
        return executeSparqlQuery<LinkBinding>(
            this.options.endpointUrl, query).then(getLinksInfo);
    }

    linkTypesOf(params: { elementId: string; }): Promise<LinkCount[]> {
        const query = DEFAULT_PREFIX + `
            SELECT ?link (count(?link) as ?instcount)
            WHERE {{
                ${escapeIri(params.elementId)} ?link ?obj.
                FILTER (IsIRI(?obj)) 
            } UNION {
                [] ?link ${escapeIri(params.elementId)}.
            }} GROUP BY ?link
        `;

        return executeSparqlQuery<LinkTypeBinding>(this.options.endpointUrl, query).then(getLinksTypesOf);
    };

    propertyCountOfClasses(): Promise<PropertyCount[]> {
        const query = DEFAULT_PREFIX + `
            SELECT ?id (count(?property) as ?count)
            WHERE {
              ?id a owl:Class.
              OPTIONAL {
                ?property rdfs:domain ?id 
              }
            } GROUP BY ?id
        `;
        return executeSparqlQuery<PropertyCountBinding>(
            this.options.endpointUrl, query).then(getPropertyCountOfConcepts);
    }

    propertyCountOfIndividuals(): Promise<PropertyCount[]> {
        const query = DEFAULT_PREFIX + `
            SELECT ?id (count(?property) as ?count)
            WHERE {
              ?id a owl:NamedIndividual.
              OPTIONAL {
                ?id ?link ?property
              }
            } GROUP BY ?id
        `;
        return executeSparqlQuery<PropertyCountBinding>(
            this.options.endpointUrl, query).then(getPropertyCountOfConcepts);
    }

    filter(params: FilterParams): Promise<Dictionary<ElementModel>> {
        if (params.limit === 0) { params.limit = 100; }

        let refQueryPart = '';
        if (params.refElementId && params.refElementLinkId) {
            refQueryPart =  `{
                ${escapeIri(params.refElementId)} ${escapeIri(params.refElementLinkId)} ?inst .
                } UNION {
                    ?inst ${escapeIri(params.refElementLinkId)} ${escapeIri(params.refElementId)} .
                }`;
        }

        if (params.refElementId && !params.refElementLinkId) {
            refQueryPart = `{
                ${escapeIri(params.refElementId)} ?p ?inst .
                } UNION {
                    ?inst ?p ${escapeIri(params.refElementId)} .
                }`;
        }

        if (!params.refElementId && params.refElementLinkId) {
            throw new Error(`Can't execute refElementLink filter without refElement`);
        }

        const elementTypePart = params.elementTypeId
            ? `?inst rdf:type ${escapeIri(params.elementTypeId)} . ${'\n'}` : '';
        const textSearchPart = params.text ? (
            ' OPTIONAL {?inst rdfs:label ?search1} \n' +
            ' FILTER regex(COALESCE(str(?search1), str(?extractedLabel)), "' + params.text + '", "i")\n') : '';
        let query = DEFAULT_PREFIX + `
            SELECT ?inst ?class ?label
            WHERE {
                {
                    SELECT distinct ?inst WHERE {
                        ${elementTypePart}
                        ${refQueryPart}
                        ${textSearchPart}
                    } ORDER BY ?sortLabel LIMIT ${params.limit} OFFSET ${params.offset}
                }
                OPTIONAL {?inst rdf:type ?foundClass}
                BIND (coalesce(?foundClass, owl:Thing) as ?class)
                OPTIONAL {?inst rdfs:label ?label}
                OPTIONAL {?inst rdfs:label ?label1. 
                    FILTER (langmatches(lang(?label1), "` + params.languageCode + `"))}
                OPTIONAL {?inst rdfs:label ?label2. 
                    FILTER (langmatches(lang(?label2), ""))}
                    ${sparqlExtractLabel('?inst', '?extractedLabel')}
                BIND (coalesce (?label1, ?label2, ?extractedLabel) as ?sortLabel)
            }
        `;
        return executeSparqlQuery<ElementBinding>(
            this.options.endpointUrl, query).then(getFilteredData);
    };
};

function escapeIri(iri: string) {
    return `<${iri}>`;
}

export function sparqlExtractLabel(subject: string, label: string): string {
    return  `
        BIND ( str( ${subject} ) as ?uriStr)
        BIND ( strafter(?uriStr, "#") as ?label3)
        BIND ( strafter(strafter(?uriStr, "//"), "/") as ?label6) 
        BIND ( strafter(?label6, "/") as ?label5)   
        BIND ( strafter(?label5, "/") as ?label4)   
        BIND (if (?label3 != "", ?label3, 
            if (?label4 != "", ?label4, 
            if (?label5 != "", ?label5, ?label6))) as ${label})
    `;
};

export function executeSparqlQuery<Binding>(endpoint: string, query: string) {
    return new Promise<SparqlResponse<Binding>>((resolve, reject) => {
        $.ajax({
            type: 'POST',
            url: endpoint,
            contentType: 'application/sparql-query',
            headers: {
                "Accept": 'application/sparql-results+json',
                "Authorization": "Basic " + btoa(Config.USERNAME + ":" + Config.PASSWORD)
            },
            data: query,
            success: result => resolve(result),
            error: (jqXHR, statusText, error) => reject(error || jqXHR),
        });
    });
}

export default SparqlDataProvider;
