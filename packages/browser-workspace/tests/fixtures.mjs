export const testScope = {id:'service', kind:'service', title:'/', source:{file:'main.bal',range:{start:{line:1,column:1},end:{line:1,column:1}}}};
export const testAgentScope = {id:'service', kind:'service', title:'/', source:testScope.source};
// Transport/agent tests use a stable discovered anchor; real discovery is tested through WASM.
export async function analyze() {
 const scope = {...testScope,text:'',moduleId:'browser/http_service',serviceType:'http',endpoints:[],definitions:[]};
 return {kind:'valid', diagnostics:[],program:{scopes:[scope],sources:{[scope.id]:scope},functions:{}}};
}

// A prepared empty graph for anchor-only lifecycle scenarios.
export function emptyGraph(located, moduleId) {
 const plan = {nodes:[],ports:[],edges:[]};
 const visibility = {node:false,header:false,container:false};
 return {...located,moduleId,entry:{kind:'function',owner:null,operation:null,name:located.id,signature:'',parameters:[],returnType:'()'},nodes:[],ports:[],edges:[],groups:[{id:`${located.id}/root`,arrangement:{kind:'sequence',members:[]},style:{profile:'root',root:visibility,inline:visibility}}],rootGroup:`${located.id}/root`,interfaces:[],emission:{root:plan,inline:plan}};
}
