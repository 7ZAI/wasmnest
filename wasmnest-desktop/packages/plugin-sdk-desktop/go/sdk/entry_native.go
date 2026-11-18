//go:build !wasip2

// 原生目标的 Entry 桩：SDK 壳只对 TinyGo wasip2 组件目标有意义（wasmimport
// 绑定在原生目标不可链接）。原生构建（go test / go vet）编译到本文件只为
// 让 sdk 包的可移植面（dispatch 等）可测；若原生代码真调用了 Entry，
// 显性 panic 而非静默空转——fail-visible，不提供「看似接线实则没接」的假象。
// （正常应用只在被 TinyGo 编译的 init() 里调用 Entry，原生路径不可达。）
package sdk

// Entry 在原生目标恒 panic（见文件头注）。签名与 wasm 侧逐字一致。
func Entry(p Plugin) {
	panic("sdk.Entry 仅在 TinyGo wasip2 组件目标可用；原生构建只支持 sdk 包的可移植单测面")
}
