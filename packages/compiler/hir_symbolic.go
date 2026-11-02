package compiler

import "fmt"

// hirBoolean is a reduced ordered BDD. Node identity is Boolean equivalence,
// so coverage and duplicate checks quantify all disclosure choices without
// enumerating their Cartesian product. 0 and 1 are the terminal nodes.
type hirBooleanNode struct{ variable, low, high int }
type hirBooleanKey struct{ op, a, b int }
type hirBoolean struct {
	nodes     []hirBooleanNode
	unique    map[hirBooleanNode]int
	cache     map[hirBooleanKey]int
	variables int
}

func newHIRBoolean() *hirBoolean {
	terminal := int(^uint(0) >> 1)
	return &hirBoolean{nodes: []hirBooleanNode{{terminal, 0, 0}, {terminal, 1, 1}}, unique: map[hirBooleanNode]int{}, cache: map[hirBooleanKey]int{}}
}
func (b *hirBoolean) make(variable, low, high int) int {
	if low == high {
		return low
	}
	key := hirBooleanNode{variable, low, high}
	if id, ok := b.unique[key]; ok {
		return id
	}
	id := len(b.nodes)
	b.nodes = append(b.nodes, key)
	b.unique[key] = id
	return id
}
func (b *hirBoolean) variable() int    { v := b.variables; b.variables++; return b.make(v, 0, 1) }
func (b *hirBoolean) not(a int) int    { return b.apply(2, a, 1) }
func (b *hirBoolean) and(a, c int) int { return b.apply(0, a, c) }
func (b *hirBoolean) or(a, c int) int  { return b.apply(1, a, c) }
func (b *hirBoolean) apply(op, a, c int) int {
	if a > c {
		a, c = c, a
	}
	switch op {
	case 0:
		if a == 0 || a == c {
			return a
		}
		if a == 1 {
			return c
		}
	case 1:
		if a == 0 || a == c {
			return c
		}
		if a == 1 {
			return 1
		}
	case 2:
		if a == 0 {
			return c
		}
		if a == c {
			return 0
		}
	}
	key := hirBooleanKey{op, a, c}
	if value, ok := b.cache[key]; ok {
		return value
	}
	x, y := b.nodes[a], b.nodes[c]
	v := x.variable
	if y.variable < v {
		v = y.variable
	}
	xl, xh, yl, yh := a, a, c, c
	if x.variable == v {
		xl, xh = x.low, x.high
	}
	if y.variable == v {
		yl, yh = y.low, y.high
	}
	low, high := b.apply(op, xl, yl), b.apply(op, xh, yh)
	value := b.make(v, low, high)
	b.cache[key] = value
	return value
}

type hirSymbolicInterfaceKey struct{ reference, id string }

type hirSymbolicInstance struct {
	index        *hirGraphIndex
	inline       bool
	boolean      *hirBoolean
	expanded     map[string]int
	children     map[string]*hirSymbolicInstance
	busy         map[hirSymbolicInterfaceKey]bool
	memo         map[hirSymbolicInterfaceKey]int
	presences    map[HIRPresenceValue]int
	nodeNonempty int
	emittedPorts map[string]int
}

func (v *hirValidator) symbolicInstance(id string, inline bool, ancestors map[string]bool, boolean *hirBoolean) *hirSymbolicInstance {
	i := &hirSymbolicInstance{index: v.graphs[id], inline: inline, boolean: boolean, expanded: map[string]int{}, children: map[string]*hirSymbolicInstance{}, busy: map[hirSymbolicInterfaceKey]bool{}, memo: map[hirSymbolicInterfaceKey]int{}, presences: map[HIRPresenceValue]int{}}
	path := map[string]bool{id: true}
	for key := range ancestors {
		path[key] = true
	}
	// Source order makes variable ordering stable even though lookup uses maps.
	for _, node := range i.index.graph.Nodes {
		r, ok := i.index.references[node.ID]
		if !ok {
			continue
		}
		i.expanded[node.ID] = 0
		if _, available := r.Availability.Value.(*HIRAvailable); available && !path[r.GraphID] {
			i.expanded[node.ID] = boolean.variable()
			i.children[node.ID] = v.symbolicInstance(r.GraphID, true, path, boolean)
		}
	}
	return i
}
func (i *hirSymbolicInstance) presence(p HIRPresence) (int, error) {
	if value, ok := i.presences[p.Value]; ok {
		return value, nil
	}
	b := i.boolean
	value := 0
	switch a := p.Value.(type) {
	case *HIRConstantPresence:
		if a.Value {
			value = 1
		}
	case *HIRAllPresence:
		value = 1
		for _, p := range a.Operands {
			v, err := i.presence(p)
			if err != nil {
				return 0, err
			}
			value = b.and(value, v)
		}
	case *HIRAnyPresence:
		for _, p := range a.Operands {
			v, err := i.presence(p)
			if err != nil {
				return 0, err
			}
			value = b.or(value, v)
		}
	case *HIRNotPresence:
		v, err := i.presence(a.Operand)
		if err != nil {
			return 0, err
		}
		value = b.not(v)
	case *HIRNonemptyPresence:
		v, err := i.effective(a.ReferenceNodeID, a.InterfaceID)
		if err != nil {
			return 0, err
		}
		value = v
	default:
		return 0, fmt.Errorf("invalid presence")
	}
	i.presences[p.Value] = value
	return value, nil
}
func (i *hirSymbolicInstance) members(face HIRInterface) (int, error) {
	value := 0
	for _, m := range face.Members {
		v, err := i.presence(m.When)
		if err != nil {
			return 0, err
		}
		value = i.boolean.or(value, v)
	}
	return value, nil
}
func (i *hirSymbolicInstance) effective(reference, id string) (int, error) {
	key := hirSymbolicInterfaceKey{reference, id}
	if value, ok := i.memo[key]; ok {
		return value, nil
	}
	if i.busy[key] {
		return 0, fmt.Errorf("cyclic interface/presence dependency %q", id)
	}
	i.busy[key] = true
	defer delete(i.busy, key)
	value := 0
	if reference == "" {
		face := i.index.interfaces[id]
		v, err := i.members(face)
		if err != nil {
			return 0, err
		}
		value = v
		for _, exp := range face.Exports {
			v, err := i.bindingActive(i.index.bindings[exp.BindingID])
			if err != nil {
				return 0, err
			}
			value = i.boolean.or(value, v)
		}
	} else {
		for _, face := range i.index.references[reference].Collapsed.Interfaces {
			if face.ID != id {
				continue
			}
			fallback, err := i.members(face)
			if err != nil {
				return 0, err
			}
			value = i.boolean.and(i.boolean.not(i.expanded[reference]), fallback)
			if child := i.children[reference]; child != nil {
				v, err := child.effective("", id)
				if err != nil {
					return 0, err
				}
				value = i.boolean.or(value, i.boolean.and(i.expanded[reference], v))
			}
			break
		}
	}
	i.memo[key] = value
	return value, nil
}
func (i *hirSymbolicInstance) bindingActive(binding hirBindingInfo) (int, error) {
	child := i.children[binding.reference]
	if child == nil {
		return 0, nil
	}
	when, err := i.presence(binding.when)
	if err != nil {
		return 0, err
	}
	nonempty, err := child.effective("", binding.target)
	if err != nil {
		return 0, err
	}
	return i.boolean.and(i.expanded[binding.reference], i.boolean.and(when, nonempty)), nil
}

// requireInterface checks only interfaces consumed by an active edge batch.
// An unused interface may legitimately describe a mode-hidden structural root.
func (i *hirSymbolicInstance) requireInterface(id string, demand int) error {
	b := i.boolean
	face := i.index.interfaces[id]
	for _, member := range face.Members {
		when, err := i.presence(member.When)
		if err != nil {
			return err
		}
		if b.and(b.and(demand, when), b.not(i.emittedPorts[member.PortID])) != 0 {
			return fmt.Errorf("active binding interface %q targets unemitted port %q", id, member.PortID)
		}
	}
	for _, exp := range face.Exports {
		binding := i.index.bindings[exp.BindingID]
		active, err := i.bindingActive(binding)
		if err != nil {
			return err
		}
		if child := i.children[binding.reference]; child != nil {
			if err := child.requireInterface(binding.target, b.and(demand, active)); err != nil {
				return err
			}
		}
	}
	return nil
}
func (i *hirSymbolicInstance) validate() error {
	for _, child := range i.children {
		if err := child.validate(); err != nil {
			return err
		}
	}
	x, b := i.index, i.boolean
	for id := range x.interfaces {
		if _, err := i.effective("", id); err != nil {
			return err
		}
	}
	for node, r := range x.references {
		for _, face := range r.Collapsed.Interfaces {
			if _, err := i.effective(node, face.ID); err != nil {
				return err
			}
		}
		if i.children[node] != nil {
			for _, binding := range x.bindings {
				if binding.reference == node {
					if _, err := i.presence(binding.when); err != nil {
						return err
					}
				}
			}
		}
	}
	nodes, ports, edges, bindings := map[string]int{}, map[string]int{}, map[string]int{}, map[string]int{}
	for id, n := range x.nodes {
		active := 1
		if _, hidden := n.Presentation.Value.(*HIRHiddenPresentation); hidden {
			active = 0
		}
		if group, ok := n.Body.Value.(*HIRGroupBody); ok {
			visibility := x.groups[group.GroupID].Style.Root
			if i.inline {
				visibility = x.groups[group.GroupID].Style.Inline
			}
			if !visibility.Node {
				active = 0
			}
		}
		if body, ok := n.Body.Value.(*HIRReferenceBody); ok {
			visibility := body.Reference.Container.Root
			if i.inline {
				visibility = body.Reference.Container.Inline
			}
			if !visibility.Node {
				active = b.and(active, b.not(i.expanded[id]))
			}
		}
		nodes[id] = active
	}
	// Ports have no intrinsic presence predicate: local slot guards describe
	// conditional creation. Consumers independently demand their endpoints.
	for id := range x.ports {
		ports[id] = 0
	}
	for id, edge := range x.edges {
		active, err := i.presence(edge.When)
		if err != nil {
			return err
		}
		if ref, ok := x.edgeReference[id]; ok {
			active = b.and(active, b.not(i.expanded[ref]))
		}
		edges[id] = active
		ports[edge.FromPort] = b.or(ports[edge.FromPort], active)
		ports[edge.ToPort] = b.or(ports[edge.ToPort], active)
	}
	for id, binding := range x.bindings {
		active, err := i.bindingActive(binding)
		if err != nil {
			return err
		}
		if binding.kind == "export" {
			active = 0
		} else {
			ports[binding.callerPort] = b.or(ports[binding.callerPort], active)
		}
		bindings[id] = active
	}
	for id, face := range x.rootBindings {
		active := 0
		if !i.inline {
			v, err := i.effective("", face)
			if err != nil {
				return err
			}
			active = v
		}
		bindings[id] = active
		root := x.interfaces[face].Root.Value.(*HIRConnectRoot)
		ports[root.ToPort] = b.or(ports[root.ToPort], active)
	}
	portDemand := ports
	ports = map[string]int{}
	for id, p := range x.ports {
		ports[id] = b.or(nodes[p.NodeID], portDemand[id])
	}
	plan := x.graph.Emission.Root
	if i.inline {
		plan = x.graph.Emission.Inline
	}
	ranks := map[string]int{}
	for rank, id := range x.preorder {
		ranks[id] = rank
	}
	for stream, slots := range [][]HIREmission{plan.Nodes, plan.Ports, plan.Edges} {
		wanted := nodes
		if stream == 1 {
			wanted = ports
		} else if stream == 2 {
			wanted = edges
		}
		seen, childSeen, bindingSeen := map[string]int{}, map[string]int{}, map[string]int{}
		type orderedSlot struct{ rank, active int }
		ordered := []orderedSlot{}
		for _, slot := range slots {
			var key string
			var intrinsic int
			var when HIRPresence
			target := seen
			switch a := slot.Value.(type) {
			case *HIRLocalEmission:
				key, intrinsic, when = a.ItemID, wanted[a.ItemID], a.When
			case *HIRChildEmission:
				key, intrinsic, when, target = a.ReferenceNodeID, i.expanded[a.ReferenceNodeID], a.When, childSeen
			case *HIRBindingEmission:
				key, intrinsic, when, target = a.BindingID, bindings[a.BindingID], a.When, bindingSeen
			}
			condition, err := i.presence(when)
			if err != nil {
				return err
			}
			if _, local := slot.Value.(*HIRLocalEmission); local {
				mask := 1
				if stream == 2 {
					if ref, ok := x.edgeReference[key]; ok {
						mask = b.not(i.expanded[ref])
					}
				}
				if b.and(b.and(condition, mask), b.not(intrinsic)) != 0 {
					return fmt.Errorf("stream %d: inactive local item %q emitted", stream, key)
				}
				if stream == 0 {
					ordered = append(ordered, orderedSlot{ranks[key] * 2, b.and(intrinsic, condition)})
				}
			}
			active := b.and(intrinsic, condition)
			if _, childSlot := slot.Value.(*HIRChildEmission); childSlot && stream == 0 {
				// Child nodes occupy the preorder interval immediately after
				// their header, even when that header is mode-hidden.
				if child := i.children[key]; child != nil {
					ordered = append(ordered, orderedSlot{ranks[key]*2 + 1, b.and(active, child.nodeNonempty)})
				}
			}
			if b.and(target[key], active) != 0 {
				return fmt.Errorf("stream %d: duplicate active emission %q", stream, key)
			}
			target[key] = b.or(target[key], active)
		}
		for id, active := range wanted {
			if stream == 1 {
				// A mode-applicable port needs at least one satisfiable local
				// slot, but need not exist whenever its owner is visible.
				if active != 0 && seen[id] == 0 {
					return fmt.Errorf("stream 1: missing port %q emission", id)
				}
				if b.and(portDemand[id], b.not(seen[id])) != 0 {
					return fmt.Errorf("active endpoint targets unemitted port %q", id)
				}
				continue
			}
			if seen[id] != active {
				return fmt.Errorf("stream %d: missing active item %q emission", stream, id)
			}
		}
		if stream == 1 {
			i.emittedPorts = seen
		}
		for id, active := range i.expanded {
			if childSeen[id] != active {
				return fmt.Errorf("stream %d: missing child %q slice", stream, id)
			}
		}
		if stream == 2 {
			for id, active := range bindings {
				if bindingSeen[id] != active {
					return fmt.Errorf("missing binding %q emission", id)
				}
			}
		}
		for a, first := range ordered {
			for _, second := range ordered[a+1:] {
				if first.rank > second.rank && b.and(first.active, second.active) != 0 {
					return fmt.Errorf("node emission is not ownership preorder")
				}
			}
		}
	}
	// Check consumers against actual slot predicates, not owner visibility.
	// A parent consuming an interface must not manufacture its target ports.
	for id, binding := range x.bindings {
		if binding.kind != "export" {
			if child := i.children[binding.reference]; child != nil {
				if err := child.requireInterface(binding.target, bindings[id]); err != nil {
					return err
				}
			}
		}
	}
	for id, face := range x.rootBindings {
		if err := i.requireInterface(face, bindings[id]); err != nil {
			return err
		}
	}
	for _, active := range nodes {
		i.nodeNonempty = b.or(i.nodeNonempty, active)
	}
	for id, child := range i.children {
		i.nodeNonempty = b.or(i.nodeNonempty, b.and(i.expanded[id], child.nodeNonempty))
	}
	return nil
}
